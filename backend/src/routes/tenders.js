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
import fs from 'fs';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);
const router = Router();
const OCDS_BASE = process.env.OCDS_BASE || 'https://ocds-api.etenders.gov.za/api/OCDSReleases';

const UPSTREAM_PAGE_SIZE = 10;
const MAX_CLOSED_AGE_DAYS = 365; // no cap on open tenders; only prune very old closed ones
const MAX_PAGES_PER_WINDOW = 25; // 10 per page -> up to 250 per window
const REQUEST_TIMEOUT_MS = 12000;
const CONCURRENCY = 4; // parallel upstream calls (the API is flaky, keep it gentle)
const CACHE_TTL_MS = 30 * 60 * 1000; // serve cache for 30 minutes
const STALE_OK_MS = 6 * 60 * 60 * 1000; // after that still serve stale while refreshing
const FAST_BUDGET_MS = 9000; // cold fill must finish under this
const EXPAND_BUDGET_MS = 5 * 60 * 1000;
const REFRESH_BUDGET_MS = 60000;

const SA_PROVINCES = [
  'Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal',
  'Limpopo', 'Mpumalanga', 'Northern Cape', 'North West', 'Western Cape',
];

// ---------------------------------------------------------------------------
// Date windows – ALWAYS built from today, newest first.
//
// The upstream API only returns ~10 releases per call, so the only way to get
// a deep list of *recent* tenders is to ask for many small, recent windows.
// (Previously these were hard-coded to 2023/2024, which is why only old, closed
// tenders ever showed up.)
// ---------------------------------------------------------------------------
const DAY = 86400000;
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * DAY);

function buildWindows(now = new Date()) {
  const out = [];
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // Tier 1: last 30 days – 2-day windows stepping by 1 day (overlap is harmless, we de-dupe),
  // multi-page. This is where nearly all still-open tenders live.
  for (let i = 0; i < 30; i++) {
    const from = addDays(today, -i - 1);
    out.push({ from: ymd(from), to: ymd(addDays(from, 1)), pages: MAX_PAGES_PER_WINDOW, tier: 'day' });
  }
  // Tier 2: days 30–90 in 3-day windows.
  for (let i = 30; i < 90; i += 3) {
    out.push({ from: ymd(addDays(today, -i - 3)), to: ymd(addDays(today, -i)), pages: 12, tier: '3day' });
  }
  // Tier 3: 90–210 days in weekly windows.
  for (let i = 90; i < 210; i += 7) {
    out.push({ from: ymd(addDays(today, -i - 7)), to: ymd(addDays(today, -i)), pages: 6, tier: 'week' });
  }
  return out;
}

// ---- in-memory store (EasyTenders-style local mirror) ----
const store = {
  byOcid: new Map(),
  updatedAt: 0, // last time anything was added/changed
  checkedAt: 0, // last time a refresh pass finished
  refreshing: false,
  filling: null,
  lastError: null,
  windowsOk: 0,
  windowsTried: 0,
};

function cacheAge() {
  const t = Math.max(store.updatedAt, store.checkedAt);
  return t ? Date.now() - t : Infinity;
}

// ---------------------------------------------------------------------------
// Province
// ---------------------------------------------------------------------------
const PROVINCE_PATTERNS = [
  ['Eastern Cape', /\beastern\s+cape\b/i],
  ['Western Cape', /\bwestern\s+cape\b/i],
  ['Northern Cape', /\bnorthern\s+cape\b/i],
  ['North West', /\bnorth[\s-]+west\b/i],
  ['Free State', /\bfree\s+state\b/i],
  ['Gauteng', /\bgauteng\b/i],
  ['KwaZulu-Natal', /\bkwa[\s-]?zulu[\s-]*natal\b|\bkzn\b/i],
  ['Limpopo', /\blimpopo\b/i],
  ['Mpumalanga', /\bmpumalanga\b/i],
];
const PROVINCE_CODES = {
  gp: 'Gauteng', wc: 'Western Cape', ec: 'Eastern Cape', kzn: 'KwaZulu-Natal', nl: 'KwaZulu-Natal',
  fs: 'Free State', lp: 'Limpopo', mp: 'Mpumalanga', nc: 'Northern Cape', nw: 'North West',
};
const CITY_HINTS = [
  ['Gauteng', /\b(jhb|johannesburg|tshwane|pretoria|ekurhuleni|sedibeng|soweto|midrand|centurion|sandton|benoni|germiston|vereeniging|krugersdorp)\b/i],
  ['Western Cape', /\b(cape town|stellenbosch|paarl|george|worcester|mossel bay|knysna|overberg|cape winelands)\b/i],
  ['KwaZulu-Natal', /\b(ethekwini|durban|pietermaritzburg|msunduzi|richards bay|newcastle|ladysmith|umhlanga|uthukela|umgungundlovu)\b/i],
  ['Eastern Cape', /\b(buffalo city|nelson mandela bay|gqeberha|port elizabeth|east london|mthatha|makhanda|queenstown|komani)\b/i],
  ['Free State', /\b(mangaung|bloemfontein|welkom|bethlehem|sasolburg)\b/i],
  ['Limpopo', /\b(polokwane|thohoyandou|giyani|tzaneen|mokopane|musina|vhembe|capricorn district)\b/i],
  ['Mpumalanga', /\b(mbombela|nelspruit|emalahleni|witbank|secunda|ehlanzeni|nkangala|gert sibande)\b/i],
  ['Northern Cape', /\b(kimberley|upington|sol plaatje|kuruman|springbok)\b/i],
  ['North West', /\b(mahikeng|mafikeng|rustenburg|klerksdorp|potchefstroom|brits|bojanala)\b/i],
];

/** Turn any region-ish string into one of the 9 canonical provinces (or ''). */
function normProvince(s) {
  if (!s || typeof s !== 'string') return '';
  const str = s.trim();
  if (PROVINCE_CODES[str.toLowerCase()]) return PROVINCE_CODES[str.toLowerCase()];
  for (const [name, re] of PROVINCE_PATTERNS) if (re.test(str)) return name;
  return '';
}

function guessProvince(text) {
  if (!text) return '';
  const explicit = normProvince(text);
  if (explicit) return explicit;
  for (const [name, re] of CITY_HINTS) if (re.test(text)) return name;
  return '';
}

function addressProvince(addr) {
  if (!addr || typeof addr !== 'object') return '';
  return (
    normProvince(addr.region) ||
    normProvince(addr.locality) ||
    normProvince(addr.streetAddress) ||
    normProvince(addr.province) ||
    guessProvince([addr.locality, addr.streetAddress, addr.region].filter(Boolean).join(' '))
  );
}

function extractProvince(r, t, buyer) {
  // 1. Where the work/delivery happens (most relevant to bidders)
  for (const it of t.items || []) {
    const p = addressProvince(it.deliveryAddress) ||
      (it.deliveryLocation && normProvince(it.deliveryLocation.description || it.deliveryLocation.name));
    if (p) return p;
  }
  // 2. Procuring entity / buyer address
  const pe = t.procuringEntity || {};
  const fromPe = addressProvince(pe.address);
  if (fromPe) return fromPe;
  for (const p of r.parties || []) {
    const roles = p.roles || [];
    if (roles.includes('buyer') || roles.includes('procuringEntity')) {
      const hit = addressProvince(p.address);
      if (hit) return hit;
    }
  }
  for (const p of r.parties || []) {
    const hit = addressProvince(p.address);
    if (hit) return hit;
  }
  // 3. Text hints
  return guessProvince([buyer, t.title, t.description].filter(Boolean).join(' '));
}

// ---------------------------------------------------------------------------
// Briefing session  (Yes / No / not stated)
// ---------------------------------------------------------------------------
const BRIEF_KEY = /briefing|site[\s_-]?(visit|inspection|meeting)|clarification[\s_-]?meeting|pre[\s_-]?bid/i;

function firstString(...vals) {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  return '';
}

function boolish(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (/^(yes|y|true|compulsory|mandatory|required)\b/.test(s)) return true;
    if (/^(no|n|false|none|not\s+(required|applicable)|n\/a)\b/.test(s)) return false;
  }
  return null;
}

function walkForBriefing(obj, depth = 0, acc = []) {
  if (!obj || typeof obj !== 'object' || depth > 4) return acc;
  for (const [k, v] of Object.entries(obj)) {
    if (BRIEF_KEY.test(k)) acc.push([k, v]);
    else if (v && typeof v === 'object') walkForBriefing(v, depth + 1, acc);
  }
  return acc;
}

function extractBriefing(r, t, docTitles) {
  // A. structured data from the release (field names vary, so search defensively)
  const hits = walkForBriefing(t);
  for (const [key, v] of hits) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const compulsory = [v.compulsory, v.isCompulsory, v.mandatory, v.required].map(boolish).find((x) => x !== null);
      const date = firstString(v.date, v.dateTime, v.startDate, v.dueDate, v.meetingDate);
      const addr = v.address && typeof v.address === 'object'
        ? [v.address.streetAddress, v.address.locality, v.address.region].filter(Boolean).join(', ')
        : '';
      const venue = firstString(v.venue, v.location, v.place, addr, v.address);
      const notes = firstString(v.description, v.notes, v.details);
      return {
        required: true,
        compulsory: compulsory === undefined ? null : compulsory,
        date: date || null, venue, notes, source: 'tender data',
      };
    }
    const b = boolish(v);
    if (b === true) {
      const compulsoryText = typeof v === 'string' && /compulsory|mandatory/i.test(v);
      const nonComp = typeof v === 'string' && /non[\s-]?compulsory|optional/i.test(v);
      return {
        required: true,
        compulsory: nonComp ? false : (compulsoryText || /compulsory|mandatory/i.test(key) ? true : null),
        date: null, venue: typeof v === 'string' && v.length > 6 ? v : '', notes: '', source: 'tender data',
      };
    }
    if (b === false) return { required: false, compulsory: false, date: null, venue: '', notes: '', source: 'tender data' };
    if (typeof v === 'string' && v.trim()) {
      return { required: true, compulsory: null, date: null, venue: '', notes: v.trim(), source: 'tender data' };
    }
  }
  // B. milestones
  for (const m of t.milestones || []) {
    const label = [m.type, m.title, m.code].filter(Boolean).join(' ');
    if (BRIEF_KEY.test(label)) {
      return {
        required: true,
        compulsory: /compulsory|mandatory/i.test(label + ' ' + (m.description || '')) ? true : null,
        date: m.dueDate || m.dateMet || null, venue: '', notes: firstString(m.description), source: 'tender data',
      };
    }
  }
  // C. wording in title / description / document names
  const text = [t.title, t.description, ...(docTitles || [])].filter(Boolean).join(' \n ');
  if (/non[\s-]?compulsory\s+(site\s+)?(briefing|meeting|inspection|clarification)|(briefing|site\s+(meeting|inspection|visit))[^.\n]{0,30}non[\s-]?compulsory/i.test(text)) {
    return { required: true, compulsory: false, date: null, venue: '', notes: '', source: 'tender text' };
  }
  if (/(compulsory|mandatory)\s+(site\s+)?(briefing|inspection|meeting|clarification|visit)|(briefing|site\s+(meeting|inspection|visit))[^.\n]{0,30}(compulsory|mandatory)/i.test(text)) {
    return { required: true, compulsory: true, date: null, venue: '', notes: '', source: 'tender text' };
  }
  if (/\bno\s+(compulsory\s+)?(briefing|site\s+(meeting|inspection|visit))/i.test(text)) {
    return { required: false, compulsory: false, date: null, venue: '', notes: '', source: 'tender text' };
  }
  if (/\b(briefing\s+session|briefing|site\s+(inspection|visit|meeting)|clarification\s+meeting|pre[\s-]?bid\s+meeting)\b/i.test(text)) {
    return { required: true, compulsory: null, date: null, venue: '', notes: '', source: 'tender text' };
  }
  return { required: null, compulsory: null, date: null, venue: '', notes: '', source: '' };
}

function extractContact(r) {
  for (const p of r.parties || []) {
    const c = p.contactPoint;
    if (c && (c.name || c.email || c.telephone)) {
      return { name: c.name || '', email: c.email || '', phone: c.telephone || '', organisation: p.name || '' };
    }
  }
  const pe = (r.tender || {}).procuringEntity;
  if (pe && pe.contactPoint) {
    const c = pe.contactPoint;
    return { name: c.name || '', email: c.email || '', phone: c.telephone || '', organisation: pe.name || '' };
  }
  return null;
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
    description: d.title && d.description && d.description !== d.title ? d.description : '',
    url: d.url,
    format: d.format || '',
    datePublished: d.datePublished,
  }));

  const published = r.date || period.startDate || null;

  return {
    ocid: r.ocid,
    id: t.id || r.ocid,
    title: t.title || 'Untitled tender',
    description: t.description || '',
    buyer,
    province: extractProvince(r, t, buyer),
    category: t.mainProcurementCategory || (t.additionalProcurementCategories || [])[0] || '',
    method: t.procurementMethodDetails || t.procurementMethod || '',
    baseStatus: (t.status || '').toLowerCase() || 'active',
    published,
    openingDate: period.startDate || null,
    closingDate: period.endDate || null,
    valueZar: typeof value.amount === 'number' ? value.amount : null,
    currency: value.currency || 'ZAR',
    briefing: extractBriefing(r, t, docs.map((d) => d.title)),
    contact: extractContact(r),
    documents: docs,
    documentCount: docs.length,
    releaseId: r.id || null,
    sourceUrl: 'https://www.etenders.gov.za/',
  };
}

const CLOSED_STATUSES = new Set(['cancelled', 'canceled', 'unsuccessful', 'withdrawn', 'complete']);

/** Status / "new" flag are evaluated when served, so cached tenders close on time. */
function serialize(item, now = Date.now()) {
  const end = item.closingDate ? new Date(item.closingDate).getTime() : null;
  let status = 'open';
  if (CLOSED_STATUSES.has(item.baseStatus)) status = 'closed';
  else if (end && !Number.isNaN(end) && end < now) status = 'closed';
  // NEW = published in the last 72 hours AND still open for bids.
  let isNew = false;
  if (item.published && status === 'open') {
    const pub = new Date(item.published).getTime();
    if (!Number.isNaN(pub)) isNew = now - pub <= 3 * DAY && pub <= now + DAY;
  }
  return { ...item, status, isNew };
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

async function fetchPage(dateFrom, dateTo, pageNumber = 1) {
  const params = new URLSearchParams({
    dateFrom,
    dateTo,
    PageNumber: String(pageNumber),
    PageSize: String(UPSTREAM_PAGE_SIZE),
  });
  const url = `${OCDS_BASE}?${params}`;
  try {
    return await curlGetJson(url);
  } catch {
    return await httpsGetJson(url);
  }
}

/** Add/refresh releases. A newer release for the same ocid replaces the old one. */
function mergeIntoStore(releases) {
  let changed = 0;
  for (const r of releases || []) {
    if (!r || !r.ocid) continue;
    const existing = store.byOcid.get(r.ocid);
    if (!existing || (r.date && existing.published && r.date > existing.published)) {
      store.byOcid.set(r.ocid, shapeRelease(r));
      changed += 1;
    }
  }
  if (changed) { store.updatedAt = Date.now(); saveSnapshotSoon(); }
  evictIfNeeded();
  return changed;
}

/** No cap on how many tenders we hold. Only very old closed ones are pruned. */
function evictIfNeeded() {
  const cutoff = new Date(Date.now() - MAX_CLOSED_AGE_DAYS * DAY).toISOString();
  const now = Date.now();
  for (const [k, it] of store.byOcid) {
    if ((it.published || '') && it.published < cutoff && serialize(it, now).status === 'closed') store.byOcid.delete(k);
  }
}

/** Pull one window (page 1, then further pages while the upstream keeps returning full pages). */
async function pullWindow(w) {
  store.windowsTried += 1;
  let got = false;
  for (let page = 1; page <= (w.pages || 1); page++) {
    let pkg;
    let lastErr;
    for (let attempt = 0; attempt < 3 && !pkg; attempt++) {
      try {
        pkg = await fetchPage(w.from, w.to, page);
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
    if (!pkg) {
      store.lastError = lastErr && lastErr.message;
      break; // upstream sometimes 500s on deep pages – keep what we have
    }
    const rel = (pkg && pkg.releases) || [];
    mergeIntoStore(rel);
    if (rel.length) got = true;
    if (rel.length < UPSTREAM_PAGE_SIZE) break;
  }
  if (got) store.windowsOk += 1;
}

/** Run windows through a small worker pool, newest first, until the deadline. */
async function runWindows(windows, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let next = 0;
  const worker = async () => {
    while (next < windows.length && Date.now() < deadline) {
      await pullWindow(windows[next++]);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

/** Fast cold fill: only the most recent days, so something fresh is on screen in seconds. */
async function fastFill() {
  const windows = buildWindows().slice(0, 7);
  await runWindows(windows, FAST_BUDGET_MS);
  return store.byOcid.size;
}

function coldFill() {
  if (!store.filling) store.filling = fastFill().finally(() => { store.filling = null; });
  return store.filling;
}

/** Background deepening (full history window) or a quick top-up of just the newest days. */
async function expandFill(mode = 'full') {
  if (store.refreshing) return;
  store.refreshing = true;
  try {
    const all = buildWindows();
    if (mode === 'recent') await runWindows(all.slice(0, 14), REFRESH_BUDGET_MS);
    else await runWindows(all, EXPAND_BUDGET_MS);
  } finally {
    store.refreshing = false;
    store.checkedAt = Date.now();
  }
}

const rank = (s) => (s.status === 'closed' ? 1 : 0);
const pubKey = (s) => s.published || s.openingDate || '';

function filterSort(list, { q, statusFilter, category, province, sort }) {
  const now = Date.now();
  let out = list.map((it) => serialize(it, now));
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
  if (statusFilter === 'open') out = out.filter((t) => t.status === 'open');
  else if (statusFilter === 'closed') out = out.filter((t) => t.status === 'closed');
  if (category) out = out.filter((t) => (t.category || '').toLowerCase().includes(category));
  if (province) out = out.filter((t) => (t.province || '').toLowerCase() === province);

  if (sort === 'newest') {
    // purely by publish date, newest first
    out.sort((a, b) => pubKey(b).localeCompare(pubKey(a)));
  } else if (sort === 'closing') {
    // open tenders by closing soonest; closed ones last, most recently closed first
    out.sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      const ac = a.closingDate || '', bc = b.closingDate || '';
      if (a.status === 'closed') return bc.localeCompare(ac);
      if (!ac) return 1;
      if (!bc) return -1;
      return ac.localeCompare(bc);
    });
  } else {
    // default "recommended": OPEN first (newest published first), then closed (newest first)
    out.sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return pubKey(b).localeCompare(pubKey(a));
    });
  }
  return out;
}

async function ensureStore() {
  const age = cacheAge();
  // Fresh enough — return immediately
  if (store.byOcid.size > 0 && age < CACHE_TTL_MS) {
    if (!store.refreshing && age > CACHE_TTL_MS / 2) expandFill('recent').catch(() => {});
    return 'fresh';
  }
  // Stale but usable — return stale, top up the newest days in the background
  if (store.byOcid.size > 0 && age < STALE_OK_MS) {
    if (!store.refreshing) expandFill('recent').catch(() => {});
    return 'stale';
  }
  // Empty or very old — fast fill of the latest days, then deepen in the background
  await coldFill();
  if (store.byOcid.size > 0 && !store.refreshing) expandFill('full').catch(() => {});
  return store.byOcid.size ? 'filled' : 'empty';
}

// ---- disk snapshot: survive restarts so the list is full immediately ----
const SNAP = path.join(os.tmpdir(), 'madewell-tenders-cache.json');
function loadSnapshot() {
  try {
    const j = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
    for (const it of j.items || []) if (it && it.ocid) store.byOcid.set(it.ocid, it);
    store.updatedAt = j.savedAt || 0;
    evictIfNeeded();
  } catch { /* no snapshot yet */ }
}
let snapTimer = null;
function saveSnapshotSoon() {
  if (snapTimer) return;
  snapTimer = setTimeout(() => {
    snapTimer = null;
    try { fs.writeFileSync(SNAP, JSON.stringify({ savedAt: Date.now(), items: Array.from(store.byOcid.values()) })); } catch { /* ignore */ }
  }, 5000);
}
loadSnapshot();

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
    const province = (req.query.province || '').toLowerCase();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(5, parseInt(req.query.pageSize, 10) || 20));
    const sort = req.query.sort || 'recommended';

    const list = filterSort(Array.from(store.byOcid.values()), { q, statusFilter, category, province, sort });
    const total = list.length;
    const start = (page - 1) * pageSize;
    const items = list.slice(start, start + pageSize);

    const newest = Array.from(store.byOcid.values()).reduce((m, t) => (pubKey(t) > m ? pubKey(t) : m), '');
    const openCount = list.filter((t) => t.status === 'open').length;

    res.json({
      ok: true,
      total,
      openCount,
      page,
      pageSize,
      cache: status,
      cacheAgeSec: Math.round(cacheAge() / 1000),
      storeSize: store.byOcid.size,
      newestPublished: newest || null,
      windowsTried: store.windowsTried,
      windowsOk: store.windowsOk,
      ms: Date.now() - started,
      partial: store.byOcid.size < 50,
      warning:
        store.byOcid.size < 50
          ? 'Still building the tender cache from National Treasury — refresh in a minute for more results.'
          : undefined,
      provinces: SA_PROVINCES,
      items,
      source: 'National Treasury eTenders OCDS API',
      license: 'Open Data Commons PDDL',
    });
  } catch (err) {
    console.error('[tenders]', err.message);
    // Last resort: if we have any cache, serve it (open + newest first)
    if (store.byOcid.size) {
      const items = filterSort(Array.from(store.byOcid.values()), { sort: 'recommended' }).slice(0, 20);
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
    res.json({ ok: true, item: serialize(found) });
  } catch (err) {
    res.status(502).json({ ok: false, error: 'Could not load tender detail' });
  }
});

export { router as tendersRouter };
