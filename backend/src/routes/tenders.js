/**
 * Tender discovery – proxies National Treasury OCDS API
 * https://ocds-api.etenders.gov.za
 *
 * Upstream quirks (Nov 2026):
 * - PageSize > 10 → frequent HTTP 500
 * - PageNumber > 1 → frequent HTTP 500 for many windows
 * - Many date ranges → 500
 * So we fan out across many short/known windows, page 1 only, PageSize 10,
 * and merge unique OCIDs up to a cap (~500).
 */
import { Router } from 'express';
import https from 'https';
import { URL } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const router = Router();
const OCDS_BASE = 'https://ocds-api.etenders.gov.za/api/OCDSReleases';
const CACHE_TTL_MS = 15 * 60 * 1000;

const UPSTREAM_PAGE_SIZE = 10;
const MAX_ITEMS = 500;
const OVERALL_BUDGET_MS = 28000;
const REQUEST_TIMEOUT_MS = 14000;

const SA_PROVINCES = [
  'Eastern Cape',
  'Free State',
  'Gauteng',
  'KwaZulu-Natal',
  'KwaZulu Natal',
  'Limpopo',
  'Mpumalanga',
  'Northern Cape',
  'North West',
  'Western Cape',
];

/** Build a wide set of windows to maximise unique tenders despite page-2 failures. */
function buildWindowList() {
  const windows = [];
  // Broad reliable ranges first
  windows.push(
    { from: '2024-09-01', to: '2024-12-31' },
    { from: '2024-06-01', to: '2024-08-31' },
    { from: '2024-03-01', to: '2024-05-31' },
    { from: '2024-01-01', to: '2024-02-29' },
    { from: '2023-10-01', to: '2023-12-31' },
    { from: '2023-07-01', to: '2023-09-30' },
    { from: '2023-04-01', to: '2023-06-30' },
    { from: '2023-01-01', to: '2023-03-31' }
  );
  // Monthly slices 2024–2025 (some succeed when quarters fail)
  for (const y of [2025, 2024, 2026]) {
    for (let m = 1; m <= 12; m++) {
      if (y === 2026 && m > 11) break;
      const from = `${y}-${String(m).padStart(2, '0')}-01`;
      const lastDay = m === 12 ? 31 : new Date(Date.UTC(y, m, 0)).getUTCDate();
      const to = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      windows.push({ from, to });
    }
  }
  // de-dupe
  const seen = new Set();
  return windows.filter((w) => {
    const k = w.from + '|' + w.to;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const WINDOWS = buildWindowList();
const cache = new Map();

function cacheKey(params) {
  return JSON.stringify(params);
}

function guessProvince(text) {
  if (!text) return '';
  const lower = text.toLowerCase();
  for (const p of SA_PROVINCES) {
    if (lower.includes(p.toLowerCase())) {
      return p === 'KwaZulu Natal' ? 'KwaZulu-Natal' : p;
    }
  }
  // Common buyer hints
  if (/\b(jhb|johannesburg|tshwane|pretoria|ekurhuleni|sedibeng)\b/i.test(text)) return 'Gauteng';
  if (/\b(cape town|stellenbosch|paarl|george)\b/i.test(text)) return 'Western Cape';
  if (/\b(eThekwini|durban|pietermaritzburg|msunduzi)\b/i.test(text)) return 'KwaZulu-Natal';
  if (/\b(buffalo city|nelson mandela|pe\b|gqeberha)\b/i.test(text)) return 'Eastern Cape';
  if (/\b(mangaung|bloemfontein)\b/i.test(text)) return 'Free State';
  return '';
}

function extractProvince(r, t, buyer) {
  const addresses = [];
  const parties = r.parties || [];
  for (const p of parties) {
    const addr = (p.address || {});
    if (addr.region) return addr.region;
    if (addr.locality) addresses.push(addr.locality);
    if (addr.streetAddress) addresses.push(addr.streetAddress);
  }
  const pe = t.procuringEntity || {};
  if (pe.address && pe.address.region) return pe.address.region;
  const blob = [buyer, t.title, t.description, ...addresses].filter(Boolean).join(' ');
  return guessProvince(blob);
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
    if (!Number.isNaN(pub.getTime())) {
      isNew = (now - pub) / 86400000 <= 7;
    }
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

async function fetchPage(dateFrom, dateTo, page = 1) {
  const params = new URLSearchParams({
    dateFrom,
    dateTo,
    PageNumber: String(page),
    PageSize: String(UPSTREAM_PAGE_SIZE),
  });
  const url = `${OCDS_BASE}?${params}`;
  const ck = cacheKey({ dateFrom, dateTo, page });
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
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  throw lastErr;
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

    for (const w of WINDOWS) {
      if (Date.now() > deadline) break;
      if (byOcid.size >= MAX_ITEMS) break;
      windowsTried += 1;
      try {
        // Only page 1 is reliable on this API right now
        const pkg = await fetchPage(w.from, w.to, 1);
        const releases = pkg.releases || [];
        if (releases.length) {
          windowsOk += 1;
          for (const r of releases) {
            if (r && r.ocid && !byOcid.has(r.ocid)) {
              byOcid.set(r.ocid, shapeRelease(r));
              if (byOcid.size >= MAX_ITEMS) break;
            }
          }
        }
      } catch (err) {
        // skip failing window
      }
      // tiny pause to reduce 500 bursts
      await new Promise((r) => setTimeout(r, 80));
    }

    if (!byOcid.size) {
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
          (t.province && t.province.toLowerCase().includes(q)) ||
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
      dateFrom: WINDOWS[0]?.from,
      dateTo: WINDOWS[0]?.to,
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

    for (const w of WINDOWS) {
      if (Date.now() > deadline) break;
      try {
        const pkg = await fetchPage(w.from, w.to, 1);
        const match = (pkg.releases || []).find((r) => r.ocid === ocid);
        if (match) {
          found = shapeRelease(match);
          break;
        }
      } catch {
        /* continue */
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
