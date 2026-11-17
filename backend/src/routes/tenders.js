/**
 * Tender discovery – proxies National Treasury OCDS API
 * https://ocds-api.etenders.gov.za
 *
 * Critical constraints of the upstream API (observed Nov 2026):
 * - PageSize >= 20 often returns HTTP 500 → use PageSize 10
 * - Many date ranges return 500 → prefer known-good windows
 * - Parallel / rapid requests trigger 500s → sequential + small delays
 * - Node undici fetch is unreliable → prefer curl, fallback to https
 *
 * Strategy: try a short list of known-good windows, stop as soon as we have
 * enough rows, and enforce an overall time budget so the client never hangs.
 */
import { Router } from 'express';
import https from 'https';
import { URL } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const router = Router();
const OCDS_BASE = 'https://ocds-api.etenders.gov.za/api/OCDSReleases';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min in-process cache

const UPSTREAM_PAGE_SIZE = 10; // MUST stay <= 10 — larger sizes 500 on this API
const MAX_PAGES_PER_WINDOW = 8;
const OVERALL_BUDGET_MS = 18000; // hard stop so clients don't spin forever
const REQUEST_TIMEOUT_MS = 12000;

// Windows that currently respond with 200 + data (re-order if needed).
const RELIABLE_WINDOWS = [
  { from: '2024-09-01', to: '2024-12-31' },
  { from: '2024-06-01', to: '2024-12-31' },
  { from: '2024-01-01', to: '2024-12-31' },
  { from: '2023-07-01', to: '2023-12-31' },
];

const cache = new Map();

function cacheKey(params) {
  return JSON.stringify(params);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
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
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`OCDS ${res.statusCode}`));
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
      reject(new Error('OCDS timeout'));
    });
    req.end();
  });
}

async function curlGetJson(urlStr, timeoutMs = REQUEST_TIMEOUT_MS) {
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
    { maxBuffer: 12 * 1024 * 1024, timeout: timeoutMs + 1500 }
  );
  return JSON.parse(stdout);
}

async function fetchOcdsPage(dateFrom, dateTo, page) {
  const params = new URLSearchParams({
    dateFrom,
    dateTo,
    PageNumber: String(page),
    PageSize: String(UPSTREAM_PAGE_SIZE),
  });
  const url = `${OCDS_BASE}?${params}`;
  const ck = cacheKey({ dateFrom, dateTo, page, pageSize: UPSTREAM_PAGE_SIZE });
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let pkg;
      try {
        pkg = await curlGetJson(url);
      } catch {
        pkg = await httpsGetJson(url);
      }
      cache.set(ck, { at: Date.now(), data: pkg });
      return pkg;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function fetchWindow(dateFrom, dateTo, deadline) {
  const collected = [];
  for (let p = 1; p <= MAX_PAGES_PER_WINDOW; p++) {
    if (Date.now() > deadline) break;
    try {
      const pkg = await fetchOcdsPage(dateFrom, dateTo, p);
      const releases = pkg.releases || [];
      collected.push(...releases);
      if (releases.length < UPSTREAM_PAGE_SIZE) break;
    } catch (err) {
      console.error(`[tenders] ${dateFrom}→${dateTo} p${p}:`, err.message);
      break;
    }
  }
  return collected;
}

function mergeReleases(byOcid, releases) {
  for (const r of releases) {
    if (r && r.ocid && !byOcid.has(r.ocid)) byOcid.set(r.ocid, shapeRelease(r));
  }
}

router.get('/tenders', async (req, res) => {
  const started = Date.now();
  const deadline = started + OVERALL_BUDGET_MS;

  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const statusFilter = (req.query.status || '').toLowerCase();
    const category = (req.query.category || '').toLowerCase();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(5, parseInt(req.query.pageSize, 10) || 20));
    const sort = req.query.sort || 'closing';

    const byOcid = new Map();
    let windowsTried = 0;
    let windowsOk = 0;

    for (const w of RELIABLE_WINDOWS) {
      if (Date.now() > deadline) break;
      windowsTried += 1;
      const releases = await fetchWindow(w.from, w.to, deadline);
      if (releases.length) {
        windowsOk += 1;
        mergeReleases(byOcid, releases);
      }
      // Return as soon as we have a usable set — don't burn the full budget.
      if (byOcid.size >= 40) break;
    }

    if (!byOcid.size) {
      console.error('[tenders] empty after', Date.now() - started, 'ms');
      return res.status(502).json({
        ok: false,
        error: 'Could not load tenders from National Treasury right now. Try again shortly.',
        ms: Date.now() - started,
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

    res.json({
      ok: true,
      total,
      page,
      pageSize,
      dateFrom: RELIABLE_WINDOWS[0].from,
      dateTo: RELIABLE_WINDOWS[0].to,
      windowsTried,
      windowsOk,
      ms: Date.now() - started,
      partial: windowsOk < windowsTried,
      warning:
        windowsOk < windowsTried
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
      ms: Date.now() - started,
    });
  }
});

router.get('/tenders/:ocid', async (req, res) => {
  try {
    const ocid = decodeURIComponent(req.params.ocid);
    const deadline = Date.now() + OVERALL_BUDGET_MS;
    let found = null;

    for (const w of RELIABLE_WINDOWS) {
      if (Date.now() > deadline) break;
      const releases = await fetchWindow(w.from, w.to, deadline);
      const match = releases.find((r) => r.ocid === ocid);
      if (match) {
        found = shapeRelease(match);
        break;
      }
    }

    if (!found) return res.status(404).json({ ok: false, error: 'Tender not found' });
    res.json({ ok: true, item: found });
  } catch (err) {
    console.error('[tenders/:ocid]', err.message);
    res.status(502).json({ ok: false, error: 'Could not load tender detail' });
  }
});

export { router as tendersRouter };
