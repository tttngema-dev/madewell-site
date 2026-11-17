/**
 * Tender discovery – National Treasury OCDS proxy with cache-first serving.
 *
 * EasyTenders-style behaviour: keep a server-side cache and answer from it.
 * Never block the user on a long multi-window crawl of the flaky upstream API.
 *
 * Upstream quirks: PageSize > 10 → 500; page > 1 often 500; many date ranges 500.
 */
import { Router } from 'express';
import https from 'https';
import { URL } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const router = Router();
const OCDS_BASE = 'https://ocds-api.etenders.gov.za/api/OCDSReleases';

const UPSTREAM_PAGE_SIZE = 10;
const MAX_ITEMS = 500;
const REQUEST_TIMEOUT_MS = 12000;
const CACHE_TTL_MS = 30 * 60 * 1000; // serve cache for 30 minutes
const STALE_OK_MS = 6 * 60 * 60 * 1000; // after that still serve stale while refreshing
const FAST_BUDGET_MS = 9000; // cold fill must finish under this
const EXPAND_BUDGET_MS = 45000;

const SA_PROVINCES = [
  'Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'KwaZulu Natal',
  'Limpopo', 'Mpumalanga', 'Northern Cape', 'North West', 'Western Cape',
];

/** Windows ordered by observed reliability + likelihood of data. */
const PRIMARY_WINDOWS = [
  { from: '2024-09-01', to: '2024-12-31' },
  { from: '2024-06-01', to: '2024-12-31' },
  { from: '2024-01-01', to: '2024-12-31' },
  { from: '2023-07-01', to: '2023-12-31' },
];

function monthlyWindows() {
  const out = [];
  for (const y of [2025, 2024, 2023, 2026]) {
    for (let m = 1; m <= 12; m++) {
      if (y === 2026 && m > 11) break;
      const from = `${y}-${String(m).padStart(2, '0')}-01`;
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const to = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      out.push({ from, to });
    }
  }
  return out;
}

const EXPAND_WINDOWS = monthlyWindows();

// ---- in-memory store (EasyTenders-style local mirror) ----
const store = {
  byOcid: new Map(),
  updatedAt: 0,
  refreshing: false,
  lastError: null,
  windowsOk: 0,
  windowsTried: 0,
};

function cacheAge() {
  return store.updatedAt ? Date.now() - store.updatedAt : Infinity;
}

function storeItems() {
  return Array.from(store.byOcid.values());
}

function guessProvince(text) {
  if (!text) return '';
  const lower = text.toLowerCase();
  for (const p of SA_PROVINCES) {
    if (lower.includes(p.toLowerCase())) {
      return p === 'KwaZulu Natal' ? 'KwaZulu-Natal' : p;
    }
  }
  if (/\b(jhb|johannesburg|tshwane|pretoria|ekurhuleni|sedibeng)\b/i.test(text)) return 'Gauteng';
  if (/\b(cape town|stellenbosch|paarl|george)\b/i.test(text)) return 'Western Cape';
  if (/\b(ethekwini|durban|pietermaritzburg|msunduzi)\b/i.test(text)) return 'KwaZulu-Natal';
  if (/\b(buffalo city|nelson mandela|gqeberha)\b/i.test(text)) return 'Eastern Cape';
  if (/\b(mangaung|bloemfontein)\b/i.test(text)) return 'Free State';
  return '';
}

function extractProvince(r, t, buyer) {
  for (const p of r.parties || []) {
    const addr = p.address || {};
    if (addr.region) return addr.region;
  }
  const pe = t.procuringEntity || {};
  if (pe.address && pe.address.region) return pe.address.region;
  return guessProvince([buyer, t.title, t.description].filter(Boolean).join(' '));
}

function shapeRelease(r) {
  const t = r.tender || {};
  const period = t.tenderPeriod || {};
  const value = t.value || {};
  const buyer =
    (r.buyer && r.buyer.name) ||
    (t.procuringEntity && t.procuringEntity.name) ||
    '';
  const docs = (t.documents || []).map((d) => ({
    id: d.id,
    title: d.title || d.description || 'Document',
    url: d.url,
    format: d.format || '',
    datePublished: d.datePublished,
  }));
  const end = period.endDate ? new Date(period.endDate) : null;
  const now = new Date();
  let status = (t.status || '').toLowerCase() || 'active';
  if (end && end < now) status = 'closed';

  const published = r.date || period.startDate || null;
  let isNew = false;
  if (published) {
    const pub = new Date(published);
    if (!Number.isNaN(pub.getTime())) isNew = (now - pub) / 86400000 <= 7;
  }

  return {
    ocid: r.ocid,
    id: t.id || r.ocid,
    title: t.title || 'Untitled tender',
    description: t.description || '',
    buyer,
    province: extractProvince(r, t, buyer),
    category: t.mainProcurementCategory || (t.additionalProcurementCategories || [])[0] || '',
    method: t.procurementMethodDetails || t.procurementMethod || '',
    status,
    published,
    isNew,
    openingDate: period.startDate || null,
    closingDate: period.endDate || null,
    valueZar: typeof value.amount === 'number' ? value.amount : null,
    currency: value.currency || 'ZAR',
    documents: docs,
    documentCount: docs.length,
    sourceUrl: 'https://www.etenders.gov.za/',
  };
}

function httpsGetJson(urlStr, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'MadeWellTenders/1.0 (+https://madewell.co.za)',
          Connection: 'close',
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`OCDS ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('Invalid JSON'));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

async function curlGetJson(urlStr, timeoutMs = REQUEST_TIMEOUT_MS) {
  const timeoutSec = Math.max(5, Math.ceil(timeoutMs / 1000));
  const { stdout } = await execFileAsync(
    'curl',
    [
      '-sS', '--fail', '--max-time', String(timeoutSec),
      '-H', 'Accept: application/json',
      '-A', 'MadeWellTenders/1.0 (+https://madewell.co.za)',
      urlStr,
    ],
    { maxBuffer: 12 * 1024 * 1024, timeout: timeoutMs + 1500 }
  );
  return JSON.parse(stdout);
}

async function fetchPage(dateFrom, dateTo) {
  const params = new URLSearchParams({
    dateFrom,
    dateTo,
    PageNumber: '1',
    PageSize: String(UPSTREAM_PAGE_SIZE),
  });
  const url = `${OCDS_BASE}?${params}`;
  try {
    return await curlGetJson(url);
  } catch {
    return await httpsGetJson(url);
  }
}

function mergeIntoStore(releases) {
  let added = 0;
  for (const r of releases || []) {
    if (!r || !r.ocid) continue;
    if (!store.byOcid.has(r.ocid)) {
      store.byOcid.set(r.ocid, shapeRelease(r));
      added += 1;
    }
    if (store.byOcid.size >= MAX_ITEMS) break;
  }
  if (added) store.updatedAt = Date.now();
  return added;
}

/** Fast fill: a few primary windows only — aimed at < FAST_BUDGET_MS. */
async function fastFill() {
  const deadline = Date.now() + FAST_BUDGET_MS;
  let tried = 0;
  let ok = 0;
  for (const w of PRIMARY_WINDOWS) {
    if (Date.now() > deadline) break;
    if (store.byOcid.size >= 80) break;
    tried += 1;
    try {
      const pkg = await fetchPage(w.from, w.to);
      const n = mergeIntoStore(pkg.releases || []);
      if (n || (pkg.releases || []).length) ok += 1;
    } catch (err) {
      store.lastError = err.message;
    }
  }
  store.windowsTried += tried;
  store.windowsOk += ok;
  return store.byOcid.size;
}

/** Background expansion across monthly windows — does not block responses. */
async function expandFill() {
  if (store.refreshing) return;
  store.refreshing = true;
  const deadline = Date.now() + EXPAND_BUDGET_MS;
  try {
    for (const w of EXPAND_WINDOWS) {
      if (Date.now() > deadline) break;
      if (store.byOcid.size >= MAX_ITEMS) break;
      store.windowsTried += 1;
      try {
        const pkg = await fetchPage(w.from, w.to);
        const added = mergeIntoStore(pkg.releases || []);
        if (added) store.windowsOk += 1;
      } catch {
        /* skip */
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  } finally {
    store.refreshing = false;
  }
}

function filterSort(list, { q, statusFilter, category, sort }) {
  let out = list;
  if (q) {
    const qq = q.toLowerCase();
    out = out.filter(
      (t) =>
        (t.title && t.title.toLowerCase().includes(qq)) ||
        (t.description && t.description.toLowerCase().includes(qq)) ||
        (t.buyer && t.buyer.toLowerCase().includes(qq)) ||
        (t.province && t.province.toLowerCase().includes(qq)) ||
        (t.id && String(t.id).toLowerCase().includes(qq))
    );
  }
  if (statusFilter === 'open') out = out.filter((t) => t.status !== 'closed');
  else if (statusFilter === 'closed') out = out.filter((t) => t.status === 'closed');
  if (category) out = out.filter((t) => (t.category || '').toLowerCase().includes(category));

  if (sort === 'newest') {
    out.sort((a, b) => (b.published || '').localeCompare(a.published || ''));
  } else {
    out.sort((a, b) => {
      if (!a.closingDate) return 1;
      if (!b.closingDate) return -1;
      return a.closingDate.localeCompare(b.closingDate);
    });
  }
  return out;
}

async function ensureStore() {
  const age = cacheAge();
  // Fresh enough — return immediately
  if (store.byOcid.size > 0 && age < CACHE_TTL_MS) {
    if (!store.refreshing && age > CACHE_TTL_MS / 2) {
      // soft background refresh
      expandFill().catch(() => {});
    }
    return 'fresh';
  }
  // Stale but usable — return stale, refresh in background
  if (store.byOcid.size > 0 && age < STALE_OK_MS) {
    if (!store.refreshing) expandFill().catch(() => {});
    return 'stale';
  }
  // Empty or very old — do a fast fill, then expand in background
  await fastFill();
  if (store.byOcid.size > 0 && !store.refreshing) {
    expandFill().catch(() => {});
  }
  return store.byOcid.size ? 'filled' : 'empty';
}

// Warm the cache shortly after process start (non-blocking)
setTimeout(() => {
  ensureStore().catch((e) => console.error('[tenders] warm', e.message));
}, 1500);

router.get('/tenders', async (req, res) => {
  const started = Date.now();
  try {
    const status = await ensureStore();

    if (!store.byOcid.size) {
      return res.status(502).json({
        ok: false,
        error: 'Could not load tenders from National Treasury right now. Try again shortly.',
        ms: Date.now() - started,
      });
    }

    const q = (req.query.q || '').trim();
    const statusFilter = (req.query.status || '').toLowerCase();
    const category = (req.query.category || '').toLowerCase();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(5, parseInt(req.query.pageSize, 10) || 20));
    const sort = req.query.sort || 'closing';

    const list = filterSort(storeItems(), { q, statusFilter, category, sort });
    const total = list.length;
    const start = (page - 1) * pageSize;
    const items = list.slice(start, start + pageSize);

    res.json({
      ok: true,
      total,
      page,
      pageSize,
      cache: status,
      cacheAgeSec: Math.round(cacheAge() / 1000),
      storeSize: store.byOcid.size,
      windowsTried: store.windowsTried,
      windowsOk: store.windowsOk,
      ms: Date.now() - started,
      partial: store.byOcid.size < 50,
      warning:
        store.byOcid.size < 50
          ? 'Still building the tender cache from National Treasury — refresh in a minute for more results.'
          : undefined,
      items,
      source: 'National Treasury eTenders OCDS API',
      license: 'Open Data Commons PDDL',
    });
  } catch (err) {
    console.error('[tenders]', err.message);
    // Last resort: if we have any cache, serve it
    if (store.byOcid.size) {
      const items = storeItems().slice(0, 20);
      return res.json({
        ok: true,
        total: store.byOcid.size,
        page: 1,
        pageSize: 20,
        cache: 'error-fallback',
        items,
        ms: Date.now() - started,
        source: 'National Treasury eTenders OCDS API',
      });
    }
    res.status(502).json({
      ok: false,
      error: 'Could not load tenders from National Treasury right now. Try again shortly.',
      ms: Date.now() - started,
    });
  }
});

router.get('/tenders/:ocid', async (req, res) => {
  try {
    await ensureStore();
    const ocid = decodeURIComponent(req.params.ocid);
    const found = store.byOcid.get(ocid);
    if (!found) return res.status(404).json({ ok: false, error: 'Tender not found' });
    res.json({ ok: true, item: found });
  } catch (err) {
    res.status(502).json({ ok: false, error: 'Could not load tender detail' });
  }
});

export { router as tendersRouter };
