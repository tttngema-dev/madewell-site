/**
 * Tender discovery – proxies National Treasury OCDS API
 * https://ocds-api.etenders.gov.za
 *
 * The upstream IIS API is unreliable with Node undici/https for many ranges.
 * We prefer `curl` (available on Render/Linux) which consistently returns 200,
 * with a native https fallback. Windows of known-good dates are tried first.
 */
import { Router } from 'express';
import https from 'https';
import { URL } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const router = Router();
const OCDS_BASE = 'https://ocds-api.etenders.gov.za/api/OCDSReleases';
const CACHE_TTL_MS = 5 * 60 * 1000;

function intFromEnv(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

const UPSTREAM_PAGE_SIZE = 10; // API returns 500 for PageSize >= 20
const FETCH_RETRIES = intFromEnv('TENDER_FETCH_RETRIES', 2, 0, 5);
const MAX_PAGES_PER_WINDOW = intFromEnv('TENDER_MAX_PAGES', 15, 1, 30);
const LOOKBACK_DAYS = intFromEnv('TENDER_LOOKBACK_DAYS', 180, 30, 3650);
const WINDOW_DAYS = intFromEnv('TENDER_WINDOW_DAYS', 90, 14, 120);

const RELIABLE_WINDOWS = [
  { from: '2024-09-01', to: '2024-12-31' },
  { from: '2024-06-01', to: '2024-12-31' },
  { from: '2024-01-01', to: '2024-12-31' },
  { from: '2023-07-01', to: '2023-12-31' },
  { from: '2025-01-01', to: '2025-06-30' },
  { from: '2025-07-01', to: '2025-12-31' },
  { from: '2026-01-01', to: '2026-06-30' },
  { from: '2026-07-01', to: '2026-12-31' },
];

const cache = new Map();

function cacheKey(params) {
  return JSON.stringify(params);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return isoDate(d);
}

function today() {
  return isoDate(new Date());
}

function buildWindows(dateFrom, dateTo, windowDays = WINDOW_DAYS) {
  const windows = [];
  const end = new Date(dateTo + 'T00:00:00Z');
  const start = new Date(dateFrom + 'T00:00:00Z');
  if (end < start) return windows;

  let cursorEnd = end;
  while (cursorEnd >= start) {
    const cursorStart = new Date(cursorEnd);
    cursorStart.setUTCDate(cursorStart.getUTCDate() - (windowDays - 1));
    if (cursorStart < start) cursorStart.setTime(start.getTime());
    windows.push({ from: isoDate(cursorStart), to: isoDate(cursorEnd) });
    cursorEnd = new Date(cursorStart);
    cursorEnd.setUTCDate(cursorEnd.getUTCDate() - 1);
  }
  return windows;
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

  return {
    ocid: r.ocid,
    id: t.id || r.ocid,
    title: t.title || 'Untitled tender',
    description: t.description || '',
    buyer,
    category: t.mainProcurementCategory || (t.additionalProcurementCategories || [])[0] || '',
    method: t.procurementMethodDetails || t.procurementMethod || '',
    status,
    published: r.date || period.startDate || null,
    openingDate: period.startDate || null,
    closingDate: period.endDate || null,
    valueZar: typeof value.amount === 'number' ? value.amount : null,
    currency: value.currency || 'ZAR',
    documents: docs,
    documentCount: docs.length,
    sourceUrl: 'https://www.etenders.gov.za/',
  };
}

function httpsGetJson(urlStr, timeoutMs = 25000) {
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
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`OCDS ${res.statusCode}: ${data.slice(0, 160)}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('Invalid JSON from OCDS'));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('OCDS request timeout'));
    });
    req.end();
  });
}

async function curlGetJson(urlStr, timeoutMs = 25000) {
  const timeoutSec = Math.max(5, Math.ceil(timeoutMs / 1000));
  const { stdout } = await execFileAsync(
    'curl',
    [
      '-sS',
      '--fail',
      '--max-time',
      String(timeoutSec),
      '-H',
      'Accept: application/json',
      '-A',
      'MadeWellTenders/1.0 (+https://madewell.co.za)',
      urlStr,
    ],
    { maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs + 2000 }
  );
  return JSON.parse(stdout);
}

async function fetchOcds({ dateFrom, dateTo, page = 1, pageSize = UPSTREAM_PAGE_SIZE }) {
  const params = new URLSearchParams({
    dateFrom,
    dateTo,
    PageNumber: String(page),
    PageSize: String(Math.min(pageSize, UPSTREAM_PAGE_SIZE)),
  });
  const url = `${OCDS_BASE}?${params}`;

  // Prefer curl — more reliable against National Treasury IIS than Node fetch/https.
  try {
    return await curlGetJson(url);
  } catch (curlErr) {
    try {
      return await httpsGetJson(url);
    } catch (httpsErr) {
      throw curlErr;
    }
  }
}

async function fetchOcdsWithRetry(args) {
  let lastErr;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    try {
      return await fetchOcds(args);
    } catch (err) {
      lastErr = err;
      if (attempt < FETCH_RETRIES) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

async function fetchWindow(dateFrom, dateTo) {
  const collected = [];
  let failed = false;
  let lastError = null;

  for (let p = 1; p <= MAX_PAGES_PER_WINDOW; p++) {
    const ck = cacheKey({ dateFrom, dateTo, page: p, pageSize: UPSTREAM_PAGE_SIZE });
    let pkg;
    const hit = cache.get(ck);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      pkg = hit.data;
    } else {
      try {
        pkg = await fetchOcdsWithRetry({ dateFrom, dateTo, page: p, pageSize: UPSTREAM_PAGE_SIZE });
        cache.set(ck, { at: Date.now(), data: pkg });
      } catch (err) {
        failed = true;
        lastError = err;
        console.error(`[tenders] window ${dateFrom}→${dateTo} page ${p}:`, err.message);
        break;
      }
    }
    const releases = pkg.releases || [];
    collected.push(...releases);
    if (releases.length < UPSTREAM_PAGE_SIZE) break;
  }

  return { releases: collected, failed, lastError, from: dateFrom, to: dateTo };
}

function mergeReleases(byOcid, releases) {
  for (const r of releases) {
    if (r && r.ocid && !byOcid.has(r.ocid)) {
      byOcid.set(r.ocid, shapeRelease(r));
    }
  }
}

router.get('/tenders', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const statusFilter = (req.query.status || '').toLowerCase();
    const category = (req.query.category || '').toLowerCase();
    const buyerQ = (req.query.buyer || '').toLowerCase();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(5, parseInt(req.query.pageSize, 10) || 20));
    const sort = req.query.sort || 'closing';

    let dateFrom = req.query.from || daysAgo(LOOKBACK_DAYS);
    let dateTo = req.query.to || today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) dateFrom = daysAgo(LOOKBACK_DAYS);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) dateTo = today();

    const byOcid = new Map();
    let windowsTried = 0;
    let windowsOk = 0;
    let windowsFailed = 0;
    let lastError = null;

    for (const w of RELIABLE_WINDOWS) {
      const result = await fetchWindow(w.from, w.to);
      windowsTried += 1;
      if (result.failed) {
        windowsFailed += 1;
        lastError = result.lastError;
      } else {
        windowsOk += 1;
        mergeReleases(byOcid, result.releases);
      }
      if (byOcid.size >= 150) break;
      await new Promise((r) => setTimeout(r, 120));
    }

    if (byOcid.size < 30) {
      const recent = buildWindows(dateFrom, dateTo, WINDOW_DAYS).slice(0, 6);
      for (const w of recent) {
        const result = await fetchWindow(w.from, w.to);
        windowsTried += 1;
        if (result.failed) {
          windowsFailed += 1;
          lastError = result.lastError;
        } else {
          windowsOk += 1;
          mergeReleases(byOcid, result.releases);
        }
        if (byOcid.size >= 200) break;
        await new Promise((r) => setTimeout(r, 120));
      }
    }

    if (!byOcid.size) {
      console.error('[tenders] no releases from any window:', lastError && lastError.message);
      return res.status(502).json({
        ok: false,
        error: 'Could not load tenders from National Treasury right now. Try again shortly.',
      });
    }

    let list = Array.from(byOcid.values());

    if (q) {
      list = list.filter(
        (t) =>
          (t.title && t.title.toLowerCase().includes(q)) ||
          (t.description && t.description.toLowerCase().includes(q)) ||
          (t.buyer && t.buyer.toLowerCase().includes(q)) ||
          (t.id && String(t.id).toLowerCase().includes(q))
      );
    }
    if (statusFilter === 'open') list = list.filter((t) => t.status !== 'closed');
    else if (statusFilter === 'closed') list = list.filter((t) => t.status === 'closed');
    if (category) list = list.filter((t) => (t.category || '').toLowerCase().includes(category));
    if (buyerQ) list = list.filter((t) => (t.buyer || '').toLowerCase().includes(buyerQ));

    if (sort === 'newest') {
      list.sort((a, b) => (b.published || '').localeCompare(a.published || ''));
    } else {
      list.sort((a, b) => {
        if (!a.closingDate) return 1;
        if (!b.closingDate) return -1;
        return a.closingDate.localeCompare(b.closingDate);
      });
    }

    const total = list.length;
    const start = (page - 1) * pageSize;
    const items = list.slice(start, start + pageSize);
    const partial = windowsFailed > 0;

    res.json({
      ok: true,
      total,
      page,
      pageSize,
      dateFrom,
      dateTo,
      windowsTried,
      windowsOk,
      windowsFailed,
      partial,
      warning: partial
        ? 'Some National Treasury date ranges could not be loaded; results may be incomplete.'
        : undefined,
      items,
      source: 'National Treasury eTenders OCDS API',
      license: 'Open Data Commons PDDL',
    });
  } catch (err) {
    console.error('[tenders]', err.message);
    res.status(502).json({
      ok: false,
      error: 'Could not load tenders from National Treasury right now. Try again shortly.',
    });
  }
});

router.get('/tenders/:ocid', async (req, res) => {
  try {
    const ocid = decodeURIComponent(req.params.ocid);
    let found = null;

    const windows = [
      ...RELIABLE_WINDOWS,
      ...buildWindows(daysAgo(LOOKBACK_DAYS), today(), WINDOW_DAYS).slice(0, 4),
    ];

    for (const w of windows) {
      const { releases } = await fetchWindow(w.from, w.to);
      const match = releases.find((r) => r.ocid === ocid);
      if (match) {
        found = shapeRelease(match);
        break;
      }
    }

    if (!found) return res.status(404).json({ ok: false, error: 'Tender not found in recent releases' });
    res.json({ ok: true, item: found });
  } catch (err) {
    console.error('[tenders/:ocid]', err.message);
    res.status(502).json({ ok: false, error: 'Could not load tender detail' });
  }
});

export { router as tendersRouter };
