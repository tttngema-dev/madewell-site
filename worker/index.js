/**
 * Made Well – Cloudflare Worker (additive).
 *
 * Your website files are still served straight from ./frontend by Cloudflare's static assets.
 * This Worker only runs for these paths (see "run_worker_first" in wrangler.jsonc):
 *   /sitemap.xml   -> sitemap: all important pages + every open tender
 *   /tender/*      -> a real, shareable, Google-readable page for each tender
 *   /tenders       -> normal tenders page; when opened with ?ocid=... it adds the tender's title to link previews (WhatsApp, Facebook)
 * Everything else is passed to the static files untouched.
 */
import { STATIC_URLS, LASTMOD } from './static-urls.js';
import { HEADER, FOOTER, WA } from './layout.js';

const SITE = 'https://madewelll.co.za';
const PROD_BACKEND = 'https://madewell-backend.onrender.com';
const STAGING_BACKEND = 'https://madewell-backend-staging.onrender.com';
const FETCH_TIMEOUT_MS = 8000;
const SITEMAP_FRESH_S = 3600;           // rebuild at most once an hour
const TENDER_FRESH_S = 1800;            // tender pages: 30 minutes
const STALE_KEEP_S = 7 * 86400;         // keep an old copy for a week in case the backend is asleep or down

// ---------------------------------------------------------------- helpers
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// keep identical to slug() in frontend/seo-list.js
export function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70).replace(/-+$/, '');
}
export const tenderPath = (t) => '/tender/' + (slugify(t.title) || 'tender') + '--' + encodeURIComponent(t.ocid);
const backendFor = (url, env) => (env && env.BACKEND_URL) || (/\.workers\.dev$/i.test(url.hostname) ? STAGING_BACKEND : PROD_BACKEND);
const truncate = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' }); } catch { return ''; } };
const isoDate = (iso) => { try { return new Date(iso).toISOString().slice(0, 10); } catch { return LASTMOD; } };

async function getJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json', 'User-Agent': 'MadeWellWorker/1.0' } });
    let body = null;
    try { body = await r.json(); } catch { /* not json */ }
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, body: null };
  } finally { clearTimeout(t); }
}

// A tiny two-level cache on Cloudflare's edge: a fresh copy, and a long-lived copy to fall back on.
const cacheKey = (name) => new Request('https://cache.madewell.internal/' + name);
async function cacheGet(name) { try { return typeof caches !== 'undefined' ? await caches.default.match(cacheKey(name)) : null; } catch { return null; } }
async function cachePut(name, text, contentType, seconds) {
  try { if (typeof caches !== 'undefined') await caches.default.put(cacheKey(name), new Response(text, { headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=' + seconds, 'X-Stored-At': String(Date.now()) } })); } catch { /* cache is optional */ }
}
async function cached(name, freshSeconds, build) {
  const fresh = await cacheGet(name + ':fresh');
  if (fresh) return { text: await fresh.text(), from: 'fresh' };
  const built = await build();
  if (built && built.ok) {
    await Promise.all([cachePut(name + ':fresh', built.text, built.type, freshSeconds), cachePut(name + ':stale', built.text, built.type, STALE_KEEP_S)]);
    return { text: built.text, from: 'live' };
  }
  const stale = await cacheGet(name + ':stale');
  if (stale) return { text: await stale.text(), from: 'stale' };
  return { text: null, from: 'none', built };
}

// ---------------------------------------------------------------- sitemap.xml
function sitemapXml(openTenders) {
  const urls = STATIC_URLS.map((p) => ({ loc: SITE + (p === '/' ? '/' : p), lastmod: LASTMOD }));
  const seen = new Set();
  for (const t of openTenders || []) {
    if (!t || !t.ocid || !t.title) continue;
    const loc = SITE + tenderPath(t);
    if (seen.has(loc)) continue;
    seen.add(loc);
    urls.push({ loc, lastmod: t.published ? isoDate(t.published) : LASTMOD });
    if (urls.length >= 45000) break; // sitemap limit is 50,000
  }
  const body = urls.map((u) => `<url><loc>${esc(u.loc)}</loc><lastmod>${u.lastmod}</lastmod></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}
async function handleSitemap(url, env) {
  const base = backendFor(url, env);
  const res = await cached('sitemap', SITEMAP_FRESH_S, async () => {
    const r = await getJson(base + '/api/tenders-sitemap', 12000);
    if (r.status === 200 && r.body && r.body.ok && !r.body.partial) return { ok: true, type: 'application/xml; charset=utf-8', text: sitemapXml(r.body.items) };
    return { ok: false };
  });
  const text = res.text || sitemapXml([]); // backend asleep and nothing cached: still serve every important page
  return new Response(text, { status: 200, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=1800', 'X-Sitemap-Source': res.from } });
}

// ---------------------------------------------------------------- tender pages
function parseTenderSlug(pathname) {
  const last = decodeURIComponent(pathname.replace(/^\/tender\//, '').replace(/\/+$/, ''));
  const i = last.lastIndexOf('--');
  if (i < 1 || i + 2 >= last.length) return null;
  const ocid = last.slice(i + 2);
  return /^[A-Za-z0-9._:-]{3,120}$/.test(ocid) ? { ocid, slug: last.slice(0, i) } : null;
}
const daysLeft = (iso) => Math.ceil((new Date(iso) - new Date()) / 86400000);

export function renderTender(t) {
  const path = tenderPath(t);
  const url = SITE + path;
  const closed = t.status === 'closed';
  const closeTxt = t.closingDate ? fmtDate(t.closingDate) : '';
  const left = t.closingDate ? daysLeft(t.closingDate) : null;
  const closesLabel = closed ? 'Closed' : left === null ? 'No closing date listed' : left <= 0 ? 'Closes today' : left === 1 ? 'Closes tomorrow' : `Closes in ${left} days`;
  const title = truncate(`${t.title} | ${t.buyer || 'Tender'}`, 54) + ' | Made Well';
  const where = [t.province, 'South Africa'].filter(Boolean).join(', ');
  const descr = truncate(`${t.buyer ? t.buyer + ': ' : ''}${t.title}. ${closed ? 'This tender has closed.' : closeTxt ? 'Closes ' + closeTxt + '.' : ''} ${t.province ? t.province + '.' : ''} See the details and documents on Made Well.`, 158);
  // closed for more than two weeks: keep the page for people who share it, but do not ask Google to index it
  const closedLong = closed && t.closingDate && (Date.now() - new Date(t.closingDate).getTime()) > 14 * 86400000;
  const robots = closedLong ? 'noindex, follow' : 'index, follow, max-image-preview:large';
  const provSlug = t.province ? '/tenders-in-' + slugify(t.province) : null;
  const crumbs = [['Home', '/'], ['Tenders', '/tenders']];
  if (provSlug) crumbs.push([t.province + ' tenders', provSlug]);
  crumbs.push([truncate(t.title, 60), path]);
  const ld = [
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c[0], item: SITE + c[1] })) },
    { '@context': 'https://schema.org', '@type': 'WebPage', name: t.title, description: descr, url, inLanguage: 'en-ZA', ...(t.published ? { datePublished: isoDate(t.published) } : {}), isPartOf: { '@type': 'WebSite', name: 'Made Well', url: SITE + '/' }, about: t.buyer ? { '@type': 'Organization', name: t.buyer } : undefined },
  ];
  const facts = [
    ['Buyer', t.buyer], ['Province', t.province], ['Category', t.category], ['Reference', t.id && t.id !== t.ocid ? t.id : ''],
    ['Published', t.published ? fmtDate(t.published) : ''], ['Closing date', closeTxt], ['Status', closesLabel],
    ['Briefing session', t.briefing && t.briefing.required ? (t.briefing.compulsory ? 'Compulsory' : t.briefing.compulsory === false ? 'Not compulsory' : 'Mentioned in the tender') : ''],
    ['Documents', t.documentCount ? String(t.documentCount) : ''],
  ].filter((f) => f[1]);
  const desc = String(t.description || '').trim();
  const paras = desc ? desc.slice(0, 2500).split(/\n{1,}/).map((p) => p.trim()).filter(Boolean).slice(0, 12).map((p) => `<p>${esc(p)}</p>`).join('') : '';
  const docs = (t.documents || []).slice(0, 25).map((d) => `<li>${esc(truncate(d.title, 120))}${d.format ? ' <span class="fine">(' + esc(d.format) + ')</span>' : ''}</li>`).join('');
  const deep = '/tenders?ocid=' + encodeURIComponent(t.ocid);
  const body = `
  <nav class="breadcrumb page" aria-label="Breadcrumb" style="padding-top:1.25rem"><a href="/">Home</a> &rsaquo; <a href="/tenders">Tenders</a>${provSlug ? ` &rsaquo; <a href="${provSlug}">${esc(t.province)}</a>` : ''} &rsaquo; <span aria-current="page">${esc(truncate(t.title, 60))}</span></nav>
  <main><article>
    <section class="page-hero page" style="padding-top:1rem">
      <p class="eyebrow">Tender &middot; ${esc(where)}</p>
      <h1>${esc(t.title)}</h1>
      ${t.buyer ? `<p class="lead">${esc(t.buyer)}</p>` : ''}
      <p><span class="${closed ? 'free-tag' : 'tag-free'}" style="margin-left:0">${esc(closesLabel)}</span></p>
      <div class="cta-row wrap"><a class="btn" href="${deep}">View details and documents</a><a class="btn ghost-link" href="/signup.html">Create free account</a></div>
    </section>
    <section class="sec" style="padding-top:1rem"><div class="prose">
      <h2>Tender details</h2>
      <ul>${facts.map((f) => `<li><b>${esc(f[0])}:</b> ${esc(f[1])}</li>`).join('')}</ul>
      ${paras ? `<h2>About this tender</h2>${paras}` : ''}
      ${docs ? `<h2>Documents in this tender</h2><ul>${docs}</ul><p>You can preview these documents on Made Well. <a href="${deep}">Open the tender</a>.</p>` : ''}
      <h2>Get ready to bid</h2>
      <ul><li><a href="/tender-documents-checklist-south-africa">Tender documents checklist</a></li><li><a href="/how-to-register-on-the-csd-south-africa">How to register on the CSD</a></li><li><a href="/preference-points-80-20-90-10-explained">Preference points explained</a></li>${provSlug ? `<li><a href="${provSlug}">More tenders in ${esc(t.province)}</a></li>` : ''}</ul>
      <p class="fine">Tender details come from official public sources and may change. Always confirm the closing time and the official bid documents before you submit a bid.</p>
    </div></section>
  </article></main>`;
  const head = `<meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(title)}</title><meta name="description" content="${esc(descr)}" /><meta name="robots" content="${robots}" /><link rel="canonical" href="${esc(url)}" />
<meta property="og:type" content="article" /><meta property="og:site_name" content="Made Well" /><meta property="og:locale" content="en_ZA" /><meta property="og:title" content="${esc(title)}" /><meta property="og:description" content="${esc(descr)}" /><meta property="og:url" content="${esc(url)}" /><meta property="og:image" content="${SITE}/og-image.png" />
<meta name="twitter:card" content="summary_large_image" /><meta name="twitter:title" content="${esc(title)}" /><meta name="twitter:description" content="${esc(descr)}" /><meta name="twitter:image" content="${SITE}/og-image.png" />
${ld.map((x) => `<script type="application/ld+json">${JSON.stringify(x).replace(/</g, '\\u003c')}</script>`).join('\n')}
<link rel="icon" href="/logo.png" /><link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700;800&display=swap" rel="stylesheet" /><link rel="stylesheet" href="/styles.css" /><link rel="stylesheet" href="/site.css" /><script src="/site.js" defer></script>`;
  return `<!doctype html><html lang="en"><head>${head}</head><body>${HEADER}<div class="bulbs" aria-hidden="true"><i class="a"></i><i class="b"></i></div>${body}<div class="bulbs" aria-hidden="true"><i class="a"></i><i class="b"></i></div>${FOOTER}<a class="wa-float" href="${WA}" target="_blank" rel="noopener" aria-label="Chat to us on WhatsApp">WhatsApp us</a></body></html>`;
}

function notFoundPage(retry) {
  const body = `<main><section class="page-hero page"><p class="eyebrow">${retry ? 'One moment' : '404'}</p><h1>${retry ? 'This tender is loading' : 'This tender is no longer available'}</h1><p class="lead">${retry ? 'Our tender list is warming up. Please try again in a minute.' : 'It may have closed and been removed. Here is what is open right now.'}</p><div class="cta-row wrap"><a class="btn" href="/tenders">Browse open tenders</a><a class="btn ghost-link" href="/">Go to the homepage</a></div></section></main>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${retry ? 'Tender loading' : 'Tender not found'} | Made Well</title><meta name="robots" content="noindex, follow" /><link rel="stylesheet" href="/styles.css" /><link rel="stylesheet" href="/site.css" /><script src="/site.js" defer></script></head><body>${HEADER}${body}${FOOTER}</body></html>`;
}
const htmlHeaders = (extra = {}) => ({ 'Content-Type': 'text/html; charset=utf-8', ...extra });

async function handleTender(request, url, env) {
  const parsed = parseTenderSlug(url.pathname);
  if (!parsed) return new Response(notFoundPage(false), { status: 404, headers: htmlHeaders({ 'Cache-Control': 'no-store' }) });
  const base = backendFor(url, env);
  let notFound = false, warming = false, canonical = null;
  const res = await cached('tender:' + parsed.ocid, TENDER_FRESH_S, async () => {
    const r = await getJson(`${base}/api/tenders/${encodeURIComponent(parsed.ocid)}`);
    if (r.status === 200 && r.body && r.body.ok && r.body.item) return { ok: true, type: 'text/html; charset=utf-8', text: renderTender(r.body.item) };
    if (r.status === 404) notFound = true; else warming = true; // 503 / timeout / 5xx: backend asleep or warming: "try again", never "gone"
    return { ok: false };
  });
  if (!res.text) {
    if (notFound) return new Response(notFoundPage(false), { status: 404, headers: htmlHeaders({ 'Cache-Control': 'no-store' }) });
    return new Response(notFoundPage(true), { status: 503, headers: htmlHeaders({ 'Retry-After': '300', 'Cache-Control': 'no-store' }) });
  }
  // send old or mistyped slugs to the one canonical address
  const m = res.text.match(/<link rel="canonical" href="([^"]+)"/);
  canonical = m ? m[1].replace(/&amp;/g, '&') : null;
  if (canonical) {
    const want = new URL(canonical).pathname;
    if (decodeURIComponent(url.pathname) !== decodeURIComponent(want)) return Response.redirect(SITE + want, 301);
  }
  return new Response(request.method === 'HEAD' ? null : res.text, { status: 200, headers: htmlHeaders({ 'Cache-Control': 'public, max-age=600', 'X-Tender-Source': res.from }) });
}

// ---------------------------------------------------------------- /tenders?ocid=...  (link previews only; the page itself is unchanged)
async function handleTendersPage(request, url, env) {
  const asset = await env.ASSETS.fetch(request);
  const ocid = url.searchParams.get('ocid');
  if (!ocid || !/^[A-Za-z0-9._:-]{3,120}$/.test(ocid) || !asset.ok || !(asset.headers.get('content-type') || '').includes('text/html')) return asset;
  try {
    const r = await getJson(`${backendFor(url, env)}/api/tenders/${encodeURIComponent(ocid)}`, 4000);
    const t = r.body && r.body.ok && r.body.item;
    if (!t) return asset;
    const title = truncate(`${t.title} | ${t.buyer || 'Tender'}`, 54) + ' | Made Well';
    const descr = truncate(`${t.buyer ? t.buyer + ': ' : ''}${t.title}. ${t.closingDate ? 'Closes ' + fmtDate(t.closingDate) + '.' : ''} See the details and documents on Made Well.`, 158);
    const canonical = SITE + tenderPath(t);
    const set = (attr, val) => ({ element(e) { e.setAttribute(attr, val); } });
    return new HTMLRewriter()
      .on('title', { element(e) { e.setInnerContent(title); } })
      .on('meta[name="description"]', set('content', descr))
      .on('meta[property="og:title"]', set('content', title))
      .on('meta[property="og:description"]', set('content', descr))
      .on('meta[property="og:url"]', set('content', canonical))
      .on('meta[name="twitter:title"]', set('content', title))
      .on('meta[name="twitter:description"]', set('content', descr))
      .on('link[rel="canonical"]', set('href', canonical)) // Google treats this link as the tender page
      .transform(asset);
  } catch { return asset; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' || request.method === 'HEAD') {
        if (url.pathname === '/sitemap.xml') return await handleSitemap(url, env);
        if (url.pathname.startsWith('/tender/')) return await handleTender(request, url, env);
        if (url.pathname === '/tenders' || url.pathname === '/tenders.html') return await handleTendersPage(request, url, env);
      }
    } catch (e) { console.error('worker error', e && e.message); }
    return env.ASSETS.fetch(request); // everything else: your normal static website
  },
};
