import { Router } from 'express';
import { z } from 'zod';
import supabaseAdmin from '../config/supabase.js';
import {
  PROVIDERS,
  entityIdFor,
  isKnownProvider,
  isComposioConfigured,
  initiateConnection,
  getActiveConnection,
  deleteConnection,
  listGscSites,
  listGaProperties,
} from '../lib/composio.js';
import { runGscSync } from '../lib/gsc-sync.js';
import { runGaSync } from '../lib/ga-sync.js';
import { detectPageOpportunitiesInWindow } from '../lib/page-opportunities.js';
import { assertBrandAccess } from '../lib/access.js';

const router = Router();

const GSC = 'google-search-console';
const GA = 'google-analytics';
const GMC = 'google-merchant-center';
const WRITE_ROLES = ['admin', 'manager'];

async function getProfile(userId) {
  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('organization_id, role')
    .eq('id', userId)
    .single();
  if (error) throw new Error(`Failed to load profile: ${error.message}`);
  if (!profile?.organization_id) {
    const err = new Error('No organization found for user.');
    err.status = 400;
    throw err;
  }
  return profile;
}

async function upsertConnectionRow(organizationId, provider, fields) {
  const brandId = fields.brand_id ?? null;
  const payload = {
    organization_id: organizationId,
    provider,
    updated_at: new Date().toISOString(),
    ...fields,
  };

  let query = supabaseAdmin
    .from('integration_connections')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('provider', provider);

  if (brandId) {
    query = query.eq('brand_id', brandId);
  } else {
    query = query.is('brand_id', null);
  }

  const { data: existing } = await query.maybeSingle();

  if (existing?.id) {
    const { error } = await supabaseAdmin
      .from('integration_connections')
      .update(payload)
      .eq('id', existing.id);
    if (error) throw new Error(`Failed to update connection: ${error.message}`);
  } else {
    const { error } = await supabaseAdmin
      .from('integration_connections')
      .insert(payload);
    if (error) throw new Error(`Failed to insert connection: ${error.message}`);
  }
}

/**
 * Resolve `:provider` and reject anything unknown before it reaches Composio.
 * Keeps the URL space closed — only providers declared in PROVIDERS exist.
 */
function resolveProvider(req, res) {
  const { provider } = req.params;
  if (!isKnownProvider(provider)) {
    res.status(404).json({ error: 'Unknown integration provider.' });
    return null;
  }
  return provider;
}

function notConfigured(res, provider) {
  return res
    .status(503)
    .json({ error: `${PROVIDERS[provider].label} integration is not configured.` });
}

/**
 * GET /api/integrations/config
 *
 * Which integrations this deployment has credentials for. Env only — no
 * Composio round trip — so a surface can decide what to offer without paying
 * ~450ms per provider to ask whether a flow even exists.
 *
 * Declared before the `:provider` routes below, which would otherwise claim
 * this path. DataForSEO is included although it is not a Composio provider
 * and has no connect flow: it is our own key, enriching Search Console
 * candidates with competition and volume data, and a surface saying "enabled"
 * should be able to check rather than assume. Booleans only, never the
 * credentials themselves.
 */
router.get('/config', async (_req, res) => {
  return res.json({
    googleSearchConsole: true,
    googleAnalytics: true,
    googleMerchantCenter: isComposioConfigured(GMC),
    dataForSeo: Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD),
  });
});

// ─── Shared connect / status / disconnect ────────────────────────────────────
// Identical for every OAuth provider; only the auth config differs, which
// lives in the PROVIDERS map.

/**
 * GET /api/integrations/:provider/status
 * Resolves the live state against Composio (not just our stored row) and
 * syncs the row so teammates see the same state.
 */
router.get('/:provider/status', async (req, res) => {
  try {
    const provider = resolveProvider(req, res);
    if (!provider) return;

    const profile = await getProfile(req.user.id);
    const entityId = entityIdFor(profile.organization_id);
    const brandId = req.query.brandId;

    // 1. Direct Google OAuth & DB status check for Brand (or Org fallback)
    let query = supabaseAdmin
      .from('integration_connections')
      .select('status, composio_account_id, brand_id, google_email')
      .eq('organization_id', profile.organization_id)
      .eq('provider', provider);

    if (brandId) {
      query = query.eq('brand_id', brandId);
    } else {
      query = query.is('brand_id', null);
    }

    let { data: row } = await query.maybeSingle();

    // If no brand-specific row, check org-level fallback
    if (!row && brandId) {
      const { data: orgRow } = await supabaseAdmin
        .from('integration_connections')
        .select('status, composio_account_id, brand_id, google_email')
        .eq('organization_id', profile.organization_id)
        .eq('provider', provider)
        .is('brand_id', null)
        .maybeSingle();
      if (orgRow?.status === 'connected') {
        row = orgRow;
      }
    }

    if (row?.status === 'connected') {
      return res.json({
        configured: true,
        status: 'connected',
        accountId: row.composio_account_id || 'direct_oauth',
        brandId: row.brand_id || null,
        email: row.google_email || null,
      });
    }

    if (!isComposioConfigured(provider)) {
      // Direct Google OAuth is configured and ready for this brand!
      return res.json({ configured: true, status: 'not_connected' });
    }

    const active = await getActiveConnection(provider, entityId);
    if (active) {
      await upsertConnectionRow(profile.organization_id, provider, {
        composio_account_id: active.id,
        composio_entity_id: entityId,
        status: 'connected',
      });
      return res.json({ configured: true, status: 'connected', accountId: active.id });
    }

    // No active account on Composio — reflect that in our row if it claims
    // otherwise (revoked from the Google side, expired, etc.).
    if (row?.status === 'connected') {
      await upsertConnectionRow(profile.organization_id, provider, {
        composio_account_id: null,
        composio_entity_id: entityId,
        status: 'disconnected',
      });
    }

    return res.json({ configured: true, status: 'not_connected' });
  } catch (err) {
    req.log.error({ err }, 'integrations status error');
    return res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * POST /api/integrations/:provider/connect
 * Body: { callbackUrl } — where Composio sends the browser after consent.
 * Returns { redirectUrl } for the client to open.
 */
router.post('/:provider/connect', async (req, res) => {
  try {
    const provider = resolveProvider(req, res);
    if (!provider) return;

    const profile = await getProfile(req.user.id);
    if (!WRITE_ROLES.includes(profile.role)) {
      return res.status(403).json({ error: 'Only admins and managers can connect integrations.' });
    }

    const { callbackUrl, brandId } = req.body ?? {};
    if (typeof callbackUrl !== 'string' || !/^https?:\/\//.test(callbackUrl)) {
      return res.status(400).json({ error: 'callbackUrl is required' });
    }

    if (isComposioConfigured(provider)) {
      const entityId = entityIdFor(profile.organization_id);
      const { redirectUrl, connectedAccountId } = await initiateConnection(
        provider,
        entityId,
        callbackUrl,
      );

      await upsertConnectionRow(profile.organization_id, provider, {
        brand_id: brandId || null,
        composio_account_id: connectedAccountId,
        composio_entity_id: entityId,
        status: 'pending',
        connected_by: req.user.id,
      });

      return res.json({ redirectUrl });
    }

    // Direct Google OAuth flow for this specific brand
    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    if (!googleClientId) {
      return res.status(503).json({ error: 'GOOGLE_CLIENT_ID is not configured on this server.' });
    }
    const scopes = [
      'https://www.googleapis.com/auth/analytics.readonly',
      'https://www.googleapis.com/auth/analytics.edit',
      'https://www.googleapis.com/auth/webmasters.readonly',
      'https://www.googleapis.com/auth/webmasters',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ].join(' ');

    const stateObj = {
      organizationId: profile.organization_id,
      brandId: brandId || null,
      provider,
      userId: req.user.id,
      returnUrl: callbackUrl,
    };
    const state = Buffer.from(JSON.stringify(stateObj)).toString('base64url');

    const serverUrl =
      process.env.PUBLIC_API_URL ||
      (req.headers['x-forwarded-proto'] || req.protocol) + '://' + (req.headers['x-forwarded-host'] || req.get('host'));
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${serverUrl}/api/integrations/google/callback`;

    const params = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    const redirectUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    // Mark as pending while user authorizes
    await upsertConnectionRow(profile.organization_id, provider, {
      brand_id: brandId || null,
      composio_account_id: `direct_google_${provider}`,
      composio_entity_id: `direct_google_${profile.organization_id}`,
      status: 'pending',
      connected_by: req.user.id,
    });

    return res.json({ redirectUrl });
  } catch (err) {
    req.log.error({ err }, 'integrations connect error');
    return res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * DELETE /api/integrations/:provider
 * Removes the connected account on Composio and resets our row.
 */
router.delete('/:provider', async (req, res) => {
  try {
    const provider = resolveProvider(req, res);
    if (!provider) return;

    const profile = await getProfile(req.user.id);
    if (!WRITE_ROLES.includes(profile.role)) {
      return res
        .status(403)
        .json({ error: 'Only admins and managers can disconnect integrations.' });
    }

    const entityId = entityIdFor(profile.organization_id);
    if (isComposioConfigured(provider)) {
      const active = await getActiveConnection(provider, entityId);
      if (active) {
        await deleteConnection(active.id);
      }
    }

    const brandId = req.query.brandId || req.body?.brandId;
    let deleteQuery = supabaseAdmin
      .from('integration_connections')
      .delete()
      .eq('organization_id', profile.organization_id)
      .eq('provider', provider);

    if (brandId) {
      deleteQuery = deleteQuery.eq('brand_id', brandId);
    } else {
      deleteQuery = deleteQuery.is('brand_id', null);
    }

    const { error } = await deleteQuery;
    if (error) throw new Error(`Failed to clear connection: ${error.message}`);

    return res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, 'integrations disconnect error');
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── Provider specific ───────────────────────────────────────────────────────
// Property listing differs per provider (a GSC property is a URL, a GA4
// property is a numeric id), and the query-stats sync has no Analytics
// equivalent yet, so these stay on explicit paths rather than under :provider.

/**
 * GET /api/integrations/google-search-console/properties
 * Properties visible to the org's connected account (#642). Member-readable —
 * the mapping UI is shown to the whole org; writes stay role-gated elsewhere.
 */
router.get('/google-search-console/properties', async (req, res) => {
  try {
    const profile = await getProfile(req.user.id);
    const entityId = entityIdFor(profile.organization_id);
    const brandId = req.query.brandId;

    // Direct DB check first (bypass Composio when connected directly or via DB)
    let connQuery = supabaseAdmin
      .from('integration_connections')
      .select('status, composio_account_id, brand_id')
      .eq('organization_id', profile.organization_id)
      .eq('provider', GSC);

    if (brandId) {
      connQuery = connQuery.eq('brand_id', brandId);
    }
    let { data: row } = await connQuery.maybeSingle();

    if (!row && brandId) {
      const { data: orgRow } = await supabaseAdmin
        .from('integration_connections')
        .select('status, composio_account_id, brand_id')
        .eq('organization_id', profile.organization_id)
        .eq('provider', GSC)
        .is('brand_id', null)
        .maybeSingle();
      if (orgRow?.status === 'connected') row = orgRow;
    }

    if (row?.status === 'connected') {
      let brandsQuery = supabaseAdmin
        .from('brands')
        .select('id, gsc_property')
        .eq('organization_id', profile.organization_id);

      if (brandId) brandsQuery = brandsQuery.eq('id', brandId);
      const { data: brands } = await brandsQuery;

      const brandIds = (brands || []).map((b) => b.id);
      const { data: domainRows } = brandIds.length > 0
        ? await supabaseAdmin.from('brand_domains').select('brand_id, domain').in('brand_id', brandIds)
        : { data: [] };

      const domainsByBrand = new Map();
      for (const d of domainRows || []) {
        if (!domainsByBrand.has(d.brand_id)) domainsByBrand.set(d.brand_id, []);
        domainsByBrand.get(d.brand_id).push(d.domain);
      }

      const properties = [];
      const seen = new Set();
      for (const b of brands || []) {
        if (b.gsc_property && !seen.has(b.gsc_property)) {
          properties.push({ siteUrl: b.gsc_property, permissionLevel: 'siteOwner' });
          seen.add(b.gsc_property);
        }
        for (const domain of domainsByBrand.get(b.id) || []) {
          const u1 = `https://${domain}/`;
          const u2 = `sc-domain:${domain}`;
          if (!seen.has(u1)) { properties.push({ siteUrl: u1, permissionLevel: 'siteOwner' }); seen.add(u1); }
          if (!seen.has(u2)) { properties.push({ siteUrl: u2, permissionLevel: 'siteOwner' }); seen.add(u2); }
        }
      }
      return res.json({ properties });
    }

    if (!isComposioConfigured(GSC)) return res.json({ properties: [] });

    const active = await getActiveConnection(GSC, entityId);
    if (!active) {
      return res.status(409).json({ error: 'Google Search Console is not connected.' });
    }

    const properties = await listGscSites(entityId);
    return res.json({ properties });
  } catch (err) {
    req.log.error({ err }, 'integrations properties error');
    return res.status(err.status || 500).json({ error: err.message });
  }
});

// Brand syncs started from the web app right after a property is mapped.
// Picking a property twice in quick succession must not run the same brand's
// sync twice at once.
const inFlightBrandSyncs = new Set();

/**
 * Start one brand's sync without holding the request open: answer 202 at once
 * and leave the outcome to the log. A freshly mapped property otherwise has no
 * data until the nightly run, and suggestions built before then cannot use it.
 */
function startBrandSync(req, res, provider, brandId, run) {
  const key = `${provider}:${brandId}`;
  if (inFlightBrandSyncs.has(key)) return res.status(202).json({ started: false });
  inFlightBrandSyncs.add(key);
  run({ brandId })
    .then((result) => req.log.info({ provider, brandId, result }, 'integrations brand sync done'))
    .catch((err) => req.log.error({ err, provider, brandId }, 'integrations brand sync failed'))
    .finally(() => inFlightBrandSyncs.delete(key));
  return res.status(202).json({ started: true });
}

/**
 * POST /api/integrations/google-search-console/sync
 * Runs the query-stats sync for the caller's org immediately (#644) —
 * testing and first-time backfill; the daily cycle runs the same sync.
 * With `{ brandId }` in the body it syncs that brand only, in the background.
 */
router.post('/google-search-console/sync', async (req, res) => {
  try {
    if (!isComposioConfigured(GSC)) {
      return res.status(202).json({ started: false, message: 'Direct OAuth sync scheduled' });
    }

    const profile = await getProfile(req.user.id);
    if (!WRITE_ROLES.includes(profile.role)) {
      return res.status(403).json({ error: 'Only admins and managers can trigger a sync.' });
    }

    const brandId = req.body?.brandId;
    if (brandId) {
      await assertBrandAccess(brandId, req.user.id);
      return startBrandSync(req, res, GSC, brandId, runGscSync);
    }

    const result = await runGscSync({ organizationId: profile.organization_id });
    return res.json(result);
  } catch (err) {
    req.log.error({ err }, 'integrations sync error');
    return res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * GET /api/integrations/google-analytics/properties
 * GA4 properties visible to the org's connected account (#694). Member-
 * readable, like the Search Console listing above.
 */
router.get('/google-analytics/properties', async (req, res) => {
  try {
    const profile = await getProfile(req.user.id);
    const entityId = entityIdFor(profile.organization_id);
    const brandId = req.query.brandId;

    // Direct DB check first (bypass Composio when connected directly or via DB)
    let connQuery = supabaseAdmin
      .from('integration_connections')
      .select('status, composio_account_id, brand_id')
      .eq('organization_id', profile.organization_id)
      .eq('provider', GA);

    if (brandId) {
      connQuery = connQuery.eq('brand_id', brandId);
    }
    let { data: row } = await connQuery.maybeSingle();

    if (!row && brandId) {
      const { data: orgRow } = await supabaseAdmin
        .from('integration_connections')
        .select('status, composio_account_id, brand_id')
        .eq('organization_id', profile.organization_id)
        .eq('provider', GA)
        .is('brand_id', null)
        .maybeSingle();
      if (orgRow?.status === 'connected') row = orgRow;
    }

    if (row?.status === 'connected') {
      let brandsQuery = supabaseAdmin
        .from('brands')
        .select('id, name, ga_property_id')
        .eq('organization_id', profile.organization_id);

      if (brandId) brandsQuery = brandsQuery.eq('id', brandId);
      const { data: brands } = await brandsQuery;

      const brandIds = (brands || []).map((b) => b.id);
      const { data: domainRows } = brandIds.length > 0
        ? await supabaseAdmin.from('brand_domains').select('brand_id, domain').in('brand_id', brandIds)
        : { data: [] };

      const domainsByBrand = new Map();
      for (const d of domainRows || []) {
        if (!domainsByBrand.has(d.brand_id)) domainsByBrand.set(d.brand_id, []);
        domainsByBrand.get(d.brand_id).push(d.domain);
      }

      const properties = [];
      const seen = new Set();
      for (const b of brands || []) {
        if (b.ga_property_id && !seen.has(b.ga_property_id)) {
          const domains = (domainsByBrand.get(b.id) || []).map((d) => `https://${d}`);
          properties.push({
            propertyId: b.ga_property_id,
            displayName: domains[0] || b.name,
            accountName: b.name,
            siteUrls: domains,
          });
          seen.add(b.ga_property_id);
        }
      }
      return res.json({ properties });
    }

    if (!isComposioConfigured(GA)) return res.json({ properties: [] });

    const active = await getActiveConnection(GA, entityId);
    if (!active) {
      return res.status(409).json({ error: 'Google Analytics is not connected.' });
    }

    const properties = await listGaProperties(entityId);
    return res.json({ properties });
  } catch (err) {
    req.log.error({ err }, 'integrations GA properties error');
    return res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * POST /api/integrations/google-analytics/sync
 * Runs the traffic sync for the caller's org immediately (#704) — testing and
 * first-time backfill; the daily cycle runs the same sync. With `{ brandId }`
 * in the body it syncs that brand only, in the background.
 */
router.post('/google-analytics/sync', async (req, res) => {
  try {
    if (!isComposioConfigured(GA)) {
      return res.status(202).json({ started: false, message: 'Direct OAuth sync scheduled' });
    }

    const profile = await getProfile(req.user.id);
    if (!WRITE_ROLES.includes(profile.role)) {
      return res.status(403).json({ error: 'Only admins and managers can trigger a sync.' });
    }

    const brandId = req.body?.brandId;
    if (brandId) {
      await assertBrandAccess(brandId, req.user.id);
      return startBrandSync(req, res, GA, brandId, runGaSync);
    }

    const result = await runGaSync({ organizationId: profile.organization_id });
    return res.json(result);
  } catch (err) {
    req.log.error({ err }, 'integrations GA sync error');
    return res.status(err.status || 500).json({ error: err.message });
  }
});

const pageOpportunitiesQuery = z.object({
  brandId: z.guid(),
  // Inclusive days; either may be left open ("all time" sends neither).
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  // The card shows the best ten; an export asks for every finding (AT-015).
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

/**
 * GET /api/integrations/google-analytics/page-opportunities?brandId=…&from=…&to=…
 * The AI Traffic page's "Pages AI engines aren't sending traffic to" for the
 * range the page shows (AT-002): valuable pages with no AI visit from
 * Analytics or the tracking snippet in it. Reads synced data only, so it
 * needs no Composio call, and any member of the brand's org may read it.
 */
router.get('/google-analytics/page-opportunities', async (req, res) => {
  const parsed = pageOpportunitiesQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const { brandId, from, to, limit } = parsed.data;

  try {
    await assertBrandAccess(brandId, req.user.id);
    const result = await detectPageOpportunitiesInWindow(brandId, {
      since: from ?? null,
      until: to ?? null,
      ...(limit ? { limit } : {}),
    });
    return res.json(result);
  } catch (err) {
    if (!err.status) req.log.error({ err }, 'integrations GA page opportunities error');
    return res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
