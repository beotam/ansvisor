'use client';

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { BarChart3, Loader2, Search, ShoppingBag, Unplug } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import {
  getIntegrationStatus,
  disconnectIntegration,
  getGscProperties,
  getGscBrandMappings,
  setBrandGscProperty,
  getGaProperties,
  getGaBrandMappings,
  setBrandGaProperty,
  type IntegrationProvider,
  type IntegrationStatus,
} from '@/lib/actions/integrations';
import { matchProperty } from '@/lib/property-match';
import { MERCHANT_CENTER_LABEL } from '@/lib/catalog';
import { isCloud } from '@/config/plans';
import { CatalogSourcesCard, type CatalogSourcesRead } from './catalog-sources-card';
import { CatalogCategoryPages } from './catalog-category-pages';
import { MerchantCenterAccounts } from './merchant-center-accounts';
import { WebflowCard } from './webflow-card';
import { useIntegrationConnect } from '@/hooks/use-integration-connect';
import { useBrandStore } from '@/stores/use-brand-store';

/**
 * Settings → Integrations (#577, Google Analytics added in #658).
 *
 * Every OAuth provider shares the same lifecycle — not configured (self-host
 * without Composio env) → not connected → connecting (OAuth popup open,
 * polling) → connected — so the card and its state live in one place and each
 * provider only supplies its labels and any post-connection UI of its own.
 *
 * Stores and marketplaces (#1270): Google Merchant Center connects the same
 * way, then each brand picks its account, whose products land in the
 * product catalog card below it. Content management systems: where Send to
 * CMS puts a brand's pages.
 */
export function IntegrationsSection() {
  const t = useTranslations('settings');
  const { activeBrandId, brands, setActiveBrand } = useBrandStore();
  const currentBrand = brands.find((b) => b.id === activeBrandId) ?? brands[0] ?? null;

  // Bumped when a brand adds a Merchant Center account, so the catalog card lists it.
  const [catalogReads, setCatalogReads] = useState(0);
  // The catalog's sources as its card read them, for the picker to mark the accounts added.
  const [catalogSources, setCatalogSources] = useState<CatalogSourcesRead | null>(null);
  // Bumped on each read of a brand's sources after its first (a feed added or synced, a
  // file uploaded, a store connected or removed), so the category pages count their
  // products again. A brand's first read comes with the category pages' own.
  const [categoryReads, setCategoryReads] = useState(0);
  const lastSourcesRead = useRef<CatalogSourcesRead | null>(null);
  const onCatalogSources = useCallback((read: CatalogSourcesRead | null) => {
    setCatalogSources(read);
    const last = lastSourcesRead.current;
    if (!read || read === last) return;
    if (last?.brandId === read.brandId) setCategoryReads((n) => n + 1);
    lastSourcesRead.current = read;
  }, []);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('integrations')}</CardTitle>
        <CardDescription>{t('integrations_description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Brand Context Indicator & Switcher */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg bg-muted/40 p-3.5 border text-xs">
          <div className="space-y-0.5">
            <div className="font-semibold text-foreground flex items-center gap-2">
              <span>Quản lý kết nối Google cho Brand:</span>
              <Badge variant="secondary" className="font-bold text-primary px-2.5 py-0.5 text-xs">
                {currentBrand?.name || 'Mặc định'}
              </Badge>
            </div>
            <p className="text-muted-foreground">
              Mỗi Brand kết nối và đồng bộ tài khoản Google Search Console / Google Analytics độc lập.
            </p>
          </div>
          {brands.length > 1 && (
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-muted-foreground text-xs font-medium">Đổi Brand:</span>
              <Select
                value={currentBrand?.id ?? ''}
                onValueChange={(val) => val && setActiveBrand(val)}
              >
                <SelectTrigger className="h-8 w-44 text-xs bg-background">
                  <SelectValue placeholder="Chọn brand" />
                </SelectTrigger>
                <SelectContent>
                  {brands.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <IntegrationCard
          provider="google-search-console"
          label="Google Search Console"
          description="Real search queries and impressions for your site — powers prompt suggestions and search-vs-AI insights."
          icon={<Search className="h-5 w-5 text-muted-foreground" />}
          authConfigEnv="COMPOSIO_GSC_AUTH_CONFIG_ID"
          brandId={activeBrandId}
        >
          <GscPropertyMapping brandId={activeBrandId} />
        </IntegrationCard>

        <IntegrationCard
          provider="google-analytics"
          label="Google Analytics"
          description="Sessions and conversions from your GA4 property — the basis for AI traffic history without installing the tracking snippet."
          icon={<BarChart3 className="h-5 w-5 text-muted-foreground" />}
          authConfigEnv="COMPOSIO_GA_AUTH_CONFIG_ID"
          brandId={activeBrandId}
        >
          <GaPropertyMapping brandId={activeBrandId} />
        </IntegrationCard>

        <IntegrationGroup title={t('integrations_stores')}>
          <IntegrationCard
            provider="google-merchant-center"
            label={MERCHANT_CENTER_LABEL}
            description={t('merchantCenter.description')}
            icon={<ShoppingBag className="h-5 w-5 text-muted-foreground" />}
            authConfigEnv="COMPOSIO_GMC_AUTH_CONFIG_ID"
            hideUnavailable
          >
            <MerchantCenterAccounts
              sources={catalogSources}
              onConnected={() => setCatalogReads((n) => n + 1)}
            />
          </IntegrationCard>

          <CatalogSourcesCard refreshKey={catalogReads} onSources={onCatalogSources} />

          <CatalogCategoryPages refreshKey={categoryReads} />
        </IntegrationGroup>

        {/* Send to CMS destinations: a new CMS's card goes in this group. */}
        <IntegrationGroup title={t('integrations_cms')}>
          <WebflowCard />
        </IntegrationGroup>
      </CardContent>
    </Card>
  );
}

/**
 * A group of integration cards under its heading: a section the heading
 * names, so a screen reader lists the heading and the group by it.
 */
function IntegrationGroup({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-4">
      <h3 id={id} className="pt-2 text-sm font-medium text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * One integration row: status badge, Connect / Disconnect, and whatever the
 * provider wants to render once connected (`children`).
 *
 * `hideUnavailable`: a newer integration's card isn't shown while its status
 * can't be read (an API older than the web), nor on the cloud while it isn't
 * set up there; a self-hosted server keeps the set-up line.
 */
function IntegrationCard({
  provider,
  label,
  description,
  icon,
  authConfigEnv,
  brandId,
  hideUnavailable = false,
  children,
}: {
  provider: IntegrationProvider;
  label: string;
  description: string;
  icon: ReactNode;
  authConfigEnv: string;
  brandId?: string | null;
  hideUnavailable?: boolean;
  children?: ReactNode;
}) {
  const t = useTranslations('settings');
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [connectedEmail, setConnectedEmail] = useState<string | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const { connecting, connect: handleConnect } = useIntegrationConnect(provider, {
    label,
    callbackUrl: () => `${window.location.origin}/dashboard/settings?tab=integrations`,
    brandId,
    onStatus: (newStatus) => {
      setStatus(newStatus);
      if (newStatus === 'connected') load();
    },
  });

  const load = useCallback(async () => {
    try {
      const result = await getIntegrationStatus(provider, brandId);
      setStatus(result.status);
      setConnectedEmail(result.email ?? null);
    } catch (err) {
      console.error(`Failed to load ${provider} status:`, err);
      if (hideUnavailable) {
        setUnreadable(true);
        return;
      }
      toast.error('Failed to load integration status');
      setStatus('not_connected');
    }
  }, [provider, brandId, hideUnavailable]);

  useEffect(() => {
    load();
  }, [load]);

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await disconnectIntegration(provider, brandId);
      setStatus('not_connected');
      setConnectedEmail(null);
      toast.success(`${label} disconnected`);
    } catch (err) {
      toast.error(
        err instanceof Error && !err.message.includes('Minified React error')
          ? err.message
          : 'Failed to disconnect',
      );
    } finally {
      setDisconnecting(false);
    }
  };

  if (hideUnavailable && (unreadable || (status === 'not_configured' && isCloud()))) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border bg-muted/50">
            {icon}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">{label}</p>
              {status === 'connected' && (
                <Badge
                  variant="outline"
                  className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 gap-1.5"
                >
                  <span>{t('integrations_connected')}</span>
                  {connectedEmail && (
                    <span className="font-normal opacity-85">· {connectedEmail}</span>
                  )}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground truncate">{description}</p>
          </div>
        </div>

        {status === null ? (
          <Skeleton className="h-8 w-24" />
        ) : status === 'not_configured' ? (
          <Badge variant="outline" className="text-muted-foreground shrink-0">
            {t('integrations_notConfigured')}
          </Badge>
        ) : status === 'connected' ? (
          <Dialog>
            <DialogTrigger
              render={<Button variant="outline" size="sm" className="gap-2 shrink-0" />}
            >
              <Unplug className="h-3.5 w-3.5" />
              {t('integrations_disconnect')}
            </DialogTrigger>
            <DialogContent className="sm:max-w-sm">
              <DialogHeader>
                <DialogTitle>
                  {t('integrations_disconnect')} {label}
                </DialogTitle>
                <DialogDescription>{t('integrations_disconnectDescription')}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>
                  {t('integrations_cancel')}
                </DialogClose>
                <DialogClose
                  render={
                    <Button
                      variant="destructive"
                      onClick={handleDisconnect}
                      disabled={disconnecting}
                    />
                  }
                >
                  {t('integrations_disconnect')}
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : (
          <Button
            size="sm"
            className="gap-2 shrink-0"
            onClick={handleConnect}
            disabled={connecting}
          >
            {connecting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {connecting ? t('integrations_connecting') : t('integrations_connect')}
          </Button>
        )}
      </div>

      {status === 'not_configured' && (
        <p className="text-xs text-muted-foreground">
          This server has no Composio credentials for {label}. Set{' '}
          <code className="rounded bg-muted px-1">COMPOSIO_API_KEY</code> and{' '}
          <code className="rounded bg-muted px-1">{authConfigEnv}</code> in the server environment
          to enable it.
        </p>
      )}

      {status === 'connected' && children}
    </div>
  );
}

/**
 * Brand → property mapping (#642, generalised for Analytics in #694).
 *
 * The connection is org-level; each brand picks exactly one property from it.
 * Search Console and Analytics differ only in where a property's site URLs
 * come from — a GSC property *is* a URL, a GA4 property is a numeric id whose
 * URLs live on its web data streams — so both providers render this component
 * and supply their own loaders. Brands whose domain matches exactly one
 * property are premapped automatically; the picker always overrides.
 */
const NONE_VALUE = '__none__';

interface PropertyOption {
  /** Value persisted on the brand row. */
  value: string;
  /** Plain-text label — the trigger renders the selected item's text. */
  label: string;
  /** URLs this property covers, used for the domain auto-match. */
  siteUrls: string[];
}

interface BrandPropertyRow {
  brandId: string;
  brandName: string;
  value: string | null;
  domains: string[];
}

function PropertyMapping({
  sourceName,
  description,
  emptyMessage,
  loadOptions,
  loadRows,
  save,
  highlightBrandId,
}: {
  sourceName: string;
  description: string;
  emptyMessage: string;
  loadOptions: () => Promise<PropertyOption[]>;
  loadRows: () => Promise<BrandPropertyRow[]>;
  save: (brandId: string, value: string | null) => Promise<void>;
  highlightBrandId?: string | null;
}) {
  const t = useTranslations('settings');
  const [options, setOptions] = useState<PropertyOption[] | null>(null);
  const [rows, setRows] = useState<BrandPropertyRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [savingBrandId, setSavingBrandId] = useState<string | null>(null);
  const autoMatched = useRef(false);

  const load = useCallback(async () => {
    setLoadFailed(null);
    try {
      const [properties, brands] = await Promise.all([loadOptions(), loadRows()]);
      setOptions(properties);
      setRows(brands);
    } catch (err) {
      setLoadFailed(err instanceof Error ? err.message : 'Failed to load properties');
    }
  }, [loadOptions, loadRows]);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-match: premap unmapped brands whose domains match exactly one
  // property. Runs once per mount; a failed save (e.g. member role) just
  // leaves the brand unmapped for a manual pick by an admin.
  useEffect(() => {
    if (!options || !rows || autoMatched.current) return;
    autoMatched.current = true;
    (async () => {
      for (const row of rows) {
        if (row.value) continue;
        const match = matchProperty(options, row.domains);
        if (!match) continue;
        try {
          await save(row.brandId, match);
          setRows((prev) =>
            (prev ?? []).map((r) => (r.brandId === row.brandId ? { ...r, value: match } : r)),
          );
        } catch (err) {
          console.error(`${sourceName} auto-map failed:`, err);
          return; // likely a permissions error — no point retrying the rest
        }
      }
    })();
  }, [options, rows, save, sourceName]);

  const handlePick = async (brandId: string, picked: string) => {
    const value = picked === NONE_VALUE ? null : picked;
    const previous = rows;
    setSavingBrandId(brandId);
    setRows((prev) => (prev ?? []).map((r) => (r.brandId === brandId ? { ...r, value } : r)));
    try {
      await save(brandId, value);
    } catch (err) {
      setRows(previous);
      toast.error(
        err instanceof Error && !err.message.includes('Minified React error')
          ? err.message
          : 'Failed to save property',
      );
    } finally {
      setSavingBrandId(null);
    }
  };

  if (loadFailed) {
    return (
      <div className="rounded-lg border p-4 text-sm">
        <p className="text-muted-foreground">Couldn&apos;t load {sourceName} properties.</p>
        <p className="mt-1 text-xs text-muted-foreground">{loadFailed}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={load}>
          Retry
        </Button>
      </div>
    );
  }

  if (!options || !rows) {
    return <Skeleton className="h-24 w-full" />;
  }

  const mappedCount = rows.filter((r) => r.value).length;
  // The trigger renders the *value* unless the Select knows the value → label
  // mapping. Search Console values are the label (a URL), but a GA4 value is a
  // numeric id, which would otherwise show as a bare number once picked.
  const selectItems = [
    { value: NONE_VALUE, label: t('integrations_notMapped') },
    ...options.map((option) => ({ value: option.value, label: option.label })),
  ];

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{t('integrations_propertyMapping')}</p>
        <span className="text-xs text-muted-foreground">
          {mappedCount} of {rows.length} brand{rows.length !== 1 ? 's' : ''} mapped
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
      <div className="space-y-2">
        {rows.map((row) => {
          const isHighlighted = highlightBrandId && row.brandId === highlightBrandId;
          return (
            <div
              key={row.brandId}
              className={cn(
                'flex items-center justify-between gap-3 p-2 rounded-md transition-colors',
                isHighlighted ? 'bg-primary/5 border border-primary/20' : '',
              )}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate text-sm font-medium">{row.brandName}</span>
                {isHighlighted && (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-primary/30 text-primary">
                    Đang chọn
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2">
                {savingBrandId === row.brandId && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                )}
                <Select
                  items={selectItems}
                  value={row.value ?? null}
                  onValueChange={(v) => handlePick(row.brandId, v ?? NONE_VALUE)}
                >
                  <SelectTrigger className="h-8 w-64 text-xs">
                    <SelectValue placeholder={t('integrations_selectProperty')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE_VALUE}>{t('integrations_notMapped')}</SelectItem>
                    {options.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          );
        })}
      </div>
      {options.length === 0 && <p className="text-xs text-muted-foreground">{emptyMessage}</p>}
    </div>
  );
}

// Loaders live at module scope so their identity is stable across renders —
// PropertyMapping's effects depend on them.

async function loadGscOptions(brandId?: string | null): Promise<PropertyOption[]> {
  const properties = await getGscProperties(brandId);
  return properties.map((p) => ({ value: p.siteUrl, label: p.siteUrl, siteUrls: [p.siteUrl] }));
}

async function loadGscRows(): Promise<BrandPropertyRow[]> {
  const mappings = await getGscBrandMappings();
  return mappings.map((m) => ({
    brandId: m.brandId,
    brandName: m.brandName,
    value: m.gscProperty,
    domains: m.domains,
  }));
}

function GscPropertyMapping({ brandId }: { brandId?: string | null }) {
  const loadOptions = useCallback(() => loadGscOptions(brandId), [brandId]);
  return (
    <PropertyMapping
      sourceName="Search Console"
      description="Pick which Search Console property each brand's data comes from. Brands matching a property by domain are mapped automatically."
      emptyMessage="The connected account has no Search Console properties. Add your site in Search Console first, then retry."
      loadOptions={loadOptions}
      loadRows={loadGscRows}
      save={setBrandGscProperty}
      highlightBrandId={brandId}
    />
  );
}

async function loadGaOptions(brandId?: string | null): Promise<PropertyOption[]> {
  const properties = await getGaProperties(brandId);
  return properties.map((p) => ({
    value: p.propertyId,
    // Display names repeat across accounts ("GA4"), so the id disambiguates.
    label: p.accountName
      ? `${p.displayName} · ${p.accountName} (${p.propertyId})`
      : `${p.displayName} (${p.propertyId})`,
    siteUrls: p.siteUrls,
  }));
}

async function loadGaRows(): Promise<BrandPropertyRow[]> {
  const mappings = await getGaBrandMappings();
  return mappings.map((m) => ({
    brandId: m.brandId,
    brandName: m.brandName,
    value: m.gaPropertyId,
    domains: m.domains,
  }));
}

function GaPropertyMapping({ brandId }: { brandId?: string | null }) {
  const loadOptions = useCallback(() => loadGaOptions(brandId), [brandId]);
  return (
    <PropertyMapping
      sourceName="Analytics"
      description="Pick which GA4 property each brand's data comes from. Brands whose domain matches a property's web data stream are mapped automatically."
      emptyMessage="The connected account has no GA4 properties. Create one in Google Analytics first, then retry."
      loadOptions={loadOptions}
      loadRows={loadGaRows}
      save={setBrandGaProperty}
      highlightBrandId={brandId}
    />
  );
}
