import { supabaseAdmin } from '../lib/supabase.js';

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function upsertConnection(organizationId, provider, fields) {
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

export async function handleGoogleOAuthCallback(req, res) {
  const { code, state, error: authError } = req.query;

  if (authError || !code) {
    const errorMsg = authError || 'No authorization code returned from Google';
    req.log?.warn?.({ error: errorMsg }, 'Google OAuth callback cancelled or failed');
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Google Authentication</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:40px;">
          <h3 style="color:#ef4444;">Kết nối Google không thành công</h3>
          <p style="color:#666;">${escapeHtml(errorMsg)}</p>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'GOOGLE_AUTH_ERROR', error: ${JSON.stringify(errorMsg)} }, '*');
            }
            setTimeout(() => window.close(), 3000);
          </script>
        </body>
      </html>
    `);
  }

  try {
    let stateObj = {};
    try {
      stateObj = JSON.parse(Buffer.from(state, 'base64url').toString('utf-8'));
    } catch {
      stateObj = {};
    }

    const { organizationId, brandId, provider, userId } = stateObj;
    if (!organizationId || !provider) {
      throw new Error('Invalid OAuth state parameter');
    }

    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!googleClientId || !googleClientSecret) {
      throw new Error('Google OAuth credentials not configured on server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing)');
    }

    const serverUrl =
      process.env.PUBLIC_API_URL ||
      (req.headers['x-forwarded-proto'] || req.protocol) + '://' + (req.headers['x-forwarded-host'] || req.get('host'));
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${serverUrl}/api/integrations/google/callback`;

    // Exchange authorization code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: googleClientId,
        client_secret: googleClientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }).toString(),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      throw new Error(tokenData.error_description || tokenData.error || 'Failed to exchange token with Google');
    }

    // Retrieve userinfo to get the authenticated Google account email
    let googleEmail = null;
    if (tokenData.access_token) {
      try {
        const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        if (userRes.ok) {
          const userData = await userRes.json();
          googleEmail = userData.email || null;
        }
      } catch {
        // non-fatal
      }
    }

    const tokenExpiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
      : null;

    // Save tokens and mark as connected for this specific brand!
    await upsertConnection(organizationId, provider, {
      brand_id: brandId || null,
      composio_account_id: `direct_google_${provider}`,
      composio_entity_id: `direct_google_${organizationId}`,
      status: 'connected',
      connected_by: userId || null,
      access_token: tokenData.access_token || null,
      refresh_token: tokenData.refresh_token || null,
      token_expires_at: tokenExpiresAt,
      google_email: googleEmail,
    });

    req.log?.info?.({ organizationId, brandId, provider, googleEmail }, 'Google OAuth connected successfully');

    return res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Google Authentication</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:40px;">
          <h3 style="color:#10b981;">Kết nối thành công!</h3>
          <p style="color:#666;">Đã liên kết tài khoản Google: <strong>${escapeHtml(googleEmail || '')}</strong></p>
          <script>
            if (window.opener) {
              window.opener.postMessage({
                type: 'GOOGLE_AUTH_SUCCESS',
                provider: ${JSON.stringify(provider)},
                brandId: ${JSON.stringify(brandId || null)},
                email: ${JSON.stringify(googleEmail)}
              }, '*');
            }
            setTimeout(() => {
              window.close();
              if (window.opener) window.opener.focus();
            }, 1200);
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    req.log?.error?.({ err }, 'Google OAuth callback exchange error');
    return res.status(500).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Google Authentication</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:40px;">
          <h3 style="color:#ef4444;">Lỗi kết nối Google</h3>
          <p style="color:#666;">${escapeHtml(err.message)}</p>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'GOOGLE_AUTH_ERROR', error: ${JSON.stringify(err.message)} }, '*');
            }
          </script>
        </body>
      </html>
    `);
  }
}
