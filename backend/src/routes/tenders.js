/**
 * Tender discovery – proxies National Treasury OCDS API
 * https://ocds-api.etenders.gov.za
 */
import { Router } from 'express';

const router = Router();
const OCDS_BASE = 'https://ocds-api.etenders.gov.za/api/OCDSReleases';
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function cacheKey(params) {
  return JSON.stringify(params);
}
function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function today() {
  return new Date().toISOString().slice(0, 10);
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

async function fetchOcds({ dateFrom, dateTo, page = 1, pageSize = 50 }) {
  const params = new URLSearchParams({
    dateFrom,
    dateTo,
    PageNumber: String(page),
    PageSize: String(Math.min(pageSize, 100)),
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

router.get('/tenders', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const statusFilter = (req.query.status || '').toLowerCase();
    const category = (req.query.category || '').toLowerCase();
    const buyerQ = (req.query.buyer || '').toLowerCase();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(5, parseInt(req.query.pageSize, 10) || 20));
    const sort = req.query.sort || 'closing';

    let dateFrom = req.query.from || daysAgo(45);
    let dateTo = req.query.to || today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) dateFrom = daysAgo(45);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) dateTo = today();

    const all = [];
    for (let p = 1; p <= 3; p++) {
      const ck = cacheKey({ dateFrom, dateTo, page: p });
      let pkg;
      const hit = cache.get(ck);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        pkg = hit.data;
      } else {
        pkg = await fetchOcds({ dateFrom, dateTo, page: p, pageSize: 50 });
        cache.set(ck, { at: Date.now(), data: pkg });
      }
      const releases = pkg.releases || [];
      if (!releases.length) break;
      for (const r of releases) all.push(shapeRelease(r));
      if (releases.length < 50) break;
    }

    let list = all;
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

    res.json({
      ok: true,
      total,
      page,
      pageSize,
      dateFrom,
      dateTo,
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
    const dateFrom = daysAgo(90);
    const dateTo = today();
    let found = null;
    for (let p = 1; p <= 5 && !found; p++) {
      const pkg = await fetchOcds({ dateFrom, dateTo, page: p, pageSize: 50 });
      const releases = pkg.releases || [];
      const match = releases.find((r) => r.ocid === ocid);
      if (match) {
        found = shapeRelease(match);
        break;
      }
      if (releases.length < 50) break;
    }
    if (!found) return res.status(404).json({ ok: false, error: 'Tender not found in recent releases' });
    res.json({ ok: true, item: found });
  } catch (err) {
    console.error('[tenders/:ocid]', err.message);
    res.status(502).json({ ok: false, error: 'Could not load tender detail' });
  }
});

export { router as tendersRouter };
