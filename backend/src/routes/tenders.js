/**
 * Tender discovery – proxies National Treasury OCDS API
 * https://ocds-api.etenders.gov.za
 *
 * The upstream API is unreliable for many date windows (returns HTTP 500).
 * We fetch in short date chunks, skip failing windows, and aggregate what we can.
 */
import { Router } from 'express';

const router = Router();
const OCDS_BASE = 'https://ocds-api.etenders.gov.za/api/OCDSReleases';
const CACHE_TTL_MS = 5 * 60 * 1000;

function intFromEnv(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// Wider lookback so we can still surface tenders when recent months 500.
const LOOKBACK_DAYS = intFromEnv('TENDER_LOOKBACK_DAYS', 400, 30, 3650);
const MAX_PAGES_PER_WINDOW = intFromEnv('TENDER_MAX_PAGES', 8, 1, 20);
const UPSTREAM_PAGE_SIZE = 50;
const FETCH_RETRIES = intFromEnv('TENDER_FETCH_RETRIES', 1, 0, 5);
// Wider windows are more reliable on the National Treasury API than very short ones.
const WINDOW_DAYS = intFromEnv('TENDER_WINDOW_DAYS', 45, 14, 90);

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

/** Build non-overlapping [from, to] windows covering [start, end], newest first. */
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

async function fetchOcds({ dateFrom, dateTo, page = 1, pageSize = UPSTREAM_PAGE_SIZE }) {
  const params = new URLSearchParams({
    dateFrom,
    dateTo,
    PageNumber: String(page),
    PageSize: String(Math.min(pageSize, UPSTREAM_PAGE_SIZE)),
  });
  const url = `${OCDS_BASE}?${params}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OCDS ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchOcdsWithRetry(args) {
  let lastErr;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    try {
      return await fetchOcds(args);
    } catch (err) {
      lastErr = err;
      if (attempt < FETCH_RETRIES) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

/** Fetch all pages for one date window; returns releases or empty on hard failure. */
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

  return { releases: collected, failed, lastError };
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

    const windows = buildWindows(dateFrom, dateTo, WINDOW_DAYS);
    const byOcid = new Map();
    let windowsTried = 0;
    let windowsOk = 0;
    let windowsFailed = 0;
    let lastError = null;

    // Cap total windows so cold start stays within reasonable time (~30s).
    const maxWindows = intFromEnv('TENDER_MAX_WINDOWS', 24, 4, 60);

    for (const w of windows.slice(0, maxWindows)) {
      windowsTried += 1;
      const { releases, failed, lastError: err } = await fetchWindow(w.from, w.to);
      if (failed) {
        windowsFailed += 1;
        lastError = err;
      } else {
        windowsOk += 1;
      }
      for (const r of releases) {
        if (r && r.ocid && !byOcid.has(r.ocid)) {
          byOcid.set(r.ocid, shapeRelease(r));
        }
      }
      // Soft early stop if we already have a healthy set of open tenders.
      if (byOcid.size >= 400 && windowsOk >= 3) break;
    }

    // Fallback: if recent windows all failed, try a few known historical ranges
    // that the National Treasury API often still serves (broader quarters work better).
    if (byOcid.size === 0) {
      const fallbacks = [
        { from: '2024-09-01', to: '2024-12-31' },
        { from: '2024-06-01', to: '2024-08-31' },
        { from: '2024-03-01', to: '2024-05-31' },
        { from: '2023-10-01', to: '2023-12-31' },
      ];
      for (const w of fallbacks) {
        const { releases, failed, lastError: err } = await fetchWindow(w.from, w.to);
        if (failed) {
          windowsFailed += 1;
          lastError = err;
        } else {
          windowsOk += 1;
        }
        windowsTried += 1;
        for (const r of releases) {
          if (r && r.ocid && !byOcid.has(r.ocid)) {
            byOcid.set(r.ocid, shapeRelease(r));
          }
        }
        if (byOcid.size > 0) break;
      }
    }

    if (!byOcid.size && lastError) {
      console.error('[tenders] all windows failed:', lastError.message);
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
    const dateFrom = daysAgo(LOOKBACK_DAYS);
    const dateTo = today();
    const windows = buildWindows(dateFrom, dateTo, WINDOW_DAYS);
    let found = null;

    for (const w of windows.slice(0, 30)) {
      const { releases } = await fetchWindow(w.from, w.to);
      const match = releases.find((r) => r.ocid === ocid);
      if (match) {
        found = shapeRelease(match);
        break;
      }
    }

    if (!found) {
      // Last-chance historical windows
      for (const w of [
        { from: '2024-09-01', to: '2024-12-31' },
        { from: '2024-07-01', to: '2024-09-30' },
        { from: '2025-09-01', to: '2025-09-30' },
      ]) {
        const { releases } = await fetchWindow(w.from, w.to);
        const match = releases.find((r) => r.ocid === ocid);
        if (match) {
          found = shapeRelease(match);
          break;
        }
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
