/**
 * Tender alerts: users say what kind of tenders they want; once a day we email ONE digest with the best new matches.
 * Hard limit: 10 tenders per user per (South African) day, and a tender is never sent twice.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { supabase } from '../supabase.js';
import { getTendersForAlerts } from './tenders.js';
import { isPro, proUserIds, PRO_REQUIRED } from '../entitlement.js';

export const alertsRouter = Router();
const MAX_PER_DAY = 10;
const CATS = ['goods', 'services', 'works'];
const PROVS = ['Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo', 'Mpumalanga', 'Northern Cape', 'North West', 'Western Cape'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sastDate = (d = new Date()) => new Date(d.getTime() + 2 * 3600e3).toISOString().slice(0, 10); // South Africa = UTC+2, no DST
const front = () => (process.env.FRONTEND_URL || '').replace(/\/$/, '');

function cleanPrefs(b = {}) {
  const lower = (a) => (Array.isArray(a) ? a : []).map((x) => String(x).trim().toLowerCase());
  const categories = [...new Set(lower(b.categories).filter((c) => CATS.includes(c)))];
  const provinces = [...new Set((Array.isArray(b.provinces) ? b.provinces : []).map((x) => PROVS.find((p) => p.toLowerCase() === String(x).trim().toLowerCase())).filter(Boolean))];
  const kw = Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(',');
  const keywords = [...new Set(kw.map((x) => String(x).trim().slice(0, 40)).filter((x) => x.length >= 2))].slice(0, 15);
  return { enabled: !!b.enabled, categories, provinces, keywords };
}

function kwMatch(text, k) {
  const kk = k.toLowerCase();
  if (kk.length <= 3) return new RegExp('\\b' + kk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text); // "IT" must not match "with"
  return text.includes(kk);
}

/** score > 0 = matches; -1 = doesn't. */
function score(t, p) {
  if (t.status !== 'open') return -1;
  const prov = (t.province || '').toLowerCase();
  if (p.provinces.length && prov && !p.provinces.some((x) => x.toLowerCase() === prov)) return -1;
  const cat = (t.category || '').toLowerCase();
  if (p.categories.length && cat && !p.categories.includes(cat)) return -1;
  const text = `${t.title} ${t.description} ${t.buyer}`.toLowerCase();
  const hits = p.keywords.filter((k) => kwMatch(text, k));
  if (p.keywords.length && !hits.length) return -1;
  return 1 + hits.length * 10 + (p.provinces.length && prov ? 3 : 0) + (p.categories.length && cat ? 2 : 0);
}
const pubTime = (t) => (t.published ? new Date(t.published).getTime() || 0 : 0);
function rank(tenders, p, skip = new Set()) {
  return tenders.filter((t) => !skip.has(t.ocid)).map((t) => [score(t, p), t]).filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0] || pubTime(b[1]) - pubTime(a[1])).map(([, t]) => t);
}

// ---------------------------------------------------------------- email
const dayFmt = (iso) => (iso ? new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Johannesburg' }) : 'See tender');
function daysLeft(iso) { if (!iso) return null; return Math.ceil((new Date(iso) - Date.now()) / 864e5); }

function buildDigest(picks, p, base, test) {
  const f = front();
  const unsub = `${base}/api/alerts/unsubscribe?token=${p.unsub_token}`;
  const prefs = `${f}/dashboard.html#alerts`;
  const n = picks.length;
  const subject = (test ? 'Test: ' : '') + `${n} new tender${n === 1 ? '' : 's'} for you · Made Well`;
  const rows = picks.map((t) => {
    const d = daysLeft(t.closingDate);
    const left = d == null ? '' : d <= 0 ? 'Closes today' : d === 1 ? 'Closes tomorrow' : `${d} days left`;
    const meta = [t.buyer, t.province, t.category && t.category[0].toUpperCase() + t.category.slice(1)].filter(Boolean).map(esc).join(' · ');
    const link = esc(`${f}/tenders?ocid=${encodeURIComponent(t.ocid)}`);
    return `<tr><td style="padding:16px 0;border-bottom:1px solid #e8e3d6">
      <a href="${link}" style="color:#0a4fb3;font-weight:700;font-size:16px;text-decoration:underline">${esc(t.title)}</a>
      <div style="color:#667;font-size:13px;margin-top:3px">${meta}</div>
      <div style="font-size:13px;margin-top:5px"><b style="color:#b36b00">Closes ${esc(dayFmt(t.closingDate))}</b>${left ? ` <span style="color:#667">· ${left}</span>` : ''}</div>
      <table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:12px"><tr><td bgcolor="#f5a623" style="border-radius:22px"><a href="${link}" style="display:inline-block;padding:10px 20px;color:#0b1730;font-weight:700;font-size:14px;text-decoration:none;border-radius:22px">View tender &rarr;</a></td></tr></table>
    </td></tr>`;
  }).join('');
  const html = `<div style="background:#f4f1e8;padding:24px 12px;font-family:Arial,Helvetica,sans-serif"><table role="presentation" align="center" width="100%" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden">
    <tr><td style="background:#122244;padding:18px 24px;color:#fff;font-size:18px;font-weight:700">Made Well <span style="color:#f5a623">· Tender alerts</span></td></tr>
    <tr><td style="padding:22px 24px;color:#1d1d1d;line-height:1.5">
      <p style="margin:0 0 4px;font-size:20px;font-weight:700">${n} new tender${n === 1 ? '' : 's'} match your preferences</p>
      <p style="margin:0;color:#667;font-size:14px">Tap <b>View tender</b> to see the details and documents. Always confirm the closing time before you bid.</p>
      <table role="presentation" width="100%" style="margin-top:8px">${rows}</table>
      <p style="margin:22px 0 0;text-align:center"><a href="${esc(f)}/tenders.html" style="background:#f5a623;color:#0b1730;padding:12px 24px;border-radius:30px;text-decoration:none;font-weight:700">Browse all tenders</a></p>
    </td></tr>
    <tr><td style="padding:14px 24px 22px;color:#889;font-size:12px;line-height:1.5;border-top:1px solid #eee">You get at most one email a day, with up to ${MAX_PER_DAY} tenders. <a href="${esc(prefs)}" style="color:#889">Change your preferences</a> · <a href="${esc(unsub)}" style="color:#889">Unsubscribe</a></td></tr>
  </table></div>`;
  const text = [`${n} new tender${n === 1 ? '' : 's'} match your preferences`, '', ...picks.flatMap((t) => [t.title, `  ${[t.buyer, t.province].filter(Boolean).join(' · ')}`, `  Closes ${dayFmt(t.closingDate)}`, `  View tender: ${f}/tenders?ocid=${encodeURIComponent(t.ocid)}`, '']), `Change preferences: ${prefs}`, `Unsubscribe: ${unsub}`].join('\n');
  return { subject, html, text, unsub };
}

async function sendDigest(p, picks, base, test = false) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !front()) { console.warn('Alerts not sent: RESEND_API_KEY or FRONTEND_URL missing'); return false; }
  if (!p.email) return false;
  const { subject, html, text, unsub } = buildDigest(picks, p, base, test);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.FROM_EMAIL || 'Made Well <onboarding@resend.dev>', to: [p.email], subject, html, text, headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }),
  });
  if (!res.ok) { console.error('Alert email error:', res.status, await res.text()); return false; }
  return true;
}
const baseUrl = (req) => (process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

// ---------------------------------------------------------------- user endpoints
const DEFAULTS = { enabled: false, categories: [], provinces: [], keywords: [] };

alertsRouter.get('/account/alerts', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('tender_alert_prefs').select('enabled, categories, provinces, keywords, last_sent_on').eq('user_id', req.user.id).maybeSingle();
    if (error) throw error;
    const prefs = data || DEFAULTS;
    let matches = null;
    try { matches = rank(await getTendersForAlerts(), cleanPrefs(prefs)).length; } catch (_) {}
    res.json({ ok: true, prefs, matches, maxPerDay: MAX_PER_DAY });
  } catch (err) {
    console.error('[alerts get]', err.message);
    res.status(500).json({ ok: false, error: 'Could not load your alert settings. Run backend/sql/tender_alerts.sql in Supabase.' });
  }
});

alertsRouter.put('/account/alerts', requireAuth, async (req, res) => {
  try {
    const p = cleanPrefs(req.body);
    if (p.enabled && !(await isPro(req.user.id))) {
      return res.status(402).json({ ...PRO_REQUIRED, reason: 'alerts', error: 'Tender alert emails are part of Made Well Pro.' });
    }
    if (p.enabled && !p.categories.length && !p.provinces.length && !p.keywords.length) {
      return res.status(400).json({ ok: false, error: 'Pick at least one category, province or keyword so we know what to send you.' });
    }
    const { error } = await supabase.from('tender_alert_prefs').upsert({ user_id: req.user.id, ...p, email: req.user.email, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) throw error;
    let matches = null;
    try { matches = rank(await getTendersForAlerts(), p).length; } catch (_) {}
    res.json({ ok: true, prefs: p, matches });
  } catch (err) {
    console.error('[alerts put]', err.message);
    res.status(500).json({ ok: false, error: 'Could not save. Run backend/sql/tender_alerts.sql in Supabase.' });
  }
});

const lastTest = new Map();
alertsRouter.post('/account/alerts/test', requireAuth, async (req, res) => {
  try {
    if (!(await isPro(req.user.id))) return res.status(402).json({ ...PRO_REQUIRED, reason: 'alerts', error: 'Tender alert emails are part of Made Well Pro.' });
    if (Date.now() - (lastTest.get(req.user.id) || 0) < 60000) return res.status(429).json({ ok: false, error: 'Please wait a minute before sending another test.' });
    const { data } = await supabase.from('tender_alert_prefs').select('*').eq('user_id', req.user.id).maybeSingle();
    if (!data) return res.status(400).json({ ok: false, error: 'Save your preferences first.' });
    const p = { ...data, email: req.user.email };
    const picks = rank(await getTendersForAlerts(), cleanPrefs(p)).slice(0, MAX_PER_DAY);
    if (!picks.length) return res.json({ ok: true, sent: 0, message: 'No open tenders match your preferences right now. Try a wider search.' });
    lastTest.set(req.user.id, Date.now());
    const ok = await sendDigest(p, picks, baseUrl(req), true);
    res.json(ok ? { ok: true, sent: picks.length } : { ok: false, error: 'The email could not be sent. Try again shortly.' });
  } catch (err) {
    console.error('[alerts test]', err.message);
    res.status(500).json({ ok: false, error: 'Could not send the test email.' });
  }
});

// ---------------------------------------------------------------- unsubscribe (link in every email; works without signing in)
async function unsubscribe(req, res) {
  const token = String(req.query.token || req.body?.token || '');
  let done = false;
  if (/^[0-9a-f-]{36}$/i.test(token)) {
    const { data } = await supabase.from('tender_alert_prefs').update({ enabled: false, updated_at: new Date().toISOString() }).eq('unsub_token', token).select('user_id');
    done = !!data?.length;
  }
  if (req.method === 'POST') return res.status(done ? 200 : 400).send(done ? 'ok' : 'invalid');
  const f = front() || '/';
  res.status(done ? 200 : 400).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tender alerts</title><body style="font-family:Arial,sans-serif;background:#0b1730;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0"><div style="max-width:420px;padding:24px;text-align:center"><h2>${done ? 'You are unsubscribed' : 'That link is not valid'}</h2><p style="color:#c9d2e8">${done ? 'You will not get any more tender alert emails. You can turn them back on any time in your dashboard.' : 'Sign in to your dashboard to manage your tender alerts.'}</p><p><a style="color:#f5a623" href="${esc(f)}/dashboard.html#alerts">Go to my dashboard</a></p></div></body>`);
}
alertsRouter.get('/alerts/unsubscribe', unsubscribe);
alertsRouter.post('/alerts/unsubscribe', unsubscribe);

// ---------------------------------------------------------------- daily run (call once a day from the cron service)
let running = false;
async function runDigest(base) {
  const today = sastDate();
  const tenders = await getTendersForAlerts();
  const { data: users, error } = await supabase.from('tender_alert_prefs').select('*').eq('enabled', true).limit(2000);
  if (error) throw error;
  let sent = 0, skipped = 0, failed = 0;
  const pro = await proUserIds(); // alert emails are a Pro feature; free users keep their settings but get no emails
  for (const u of users || []) {
    try {
      if (!pro.has(u.user_id)) { skipped++; continue; }
      if (u.last_sent_on === today || !u.email) { skipped++; continue; }                // one digest per day
      const since = sastDate(new Date(Date.now() - 200 * 864e5));
      const { data: prev } = await supabase.from('tender_alert_sent').select('ocid, sent_on').eq('user_id', u.user_id).gte('sent_on', since);
      const already = new Set((prev || []).map((r) => r.ocid));
      const room = MAX_PER_DAY - (prev || []).filter((r) => r.sent_on === today).length; // hard daily cap
      if (room <= 0) { skipped++; continue; }
      const picks = rank(tenders, cleanPrefs(u), already).slice(0, room);
      if (!picks.length) { skipped++; continue; }                                         // never send an empty email
      if (await sendDigest(u, picks, base)) {
        await supabase.from('tender_alert_sent').upsert(picks.map((t) => ({ user_id: u.user_id, ocid: t.ocid, sent_on: today })), { onConflict: 'user_id,ocid', ignoreDuplicates: true });
        await supabase.from('tender_alert_prefs').update({ last_sent_on: today }).eq('user_id', u.user_id);
        sent++;
      } else failed++;
      await sleep(600); // Resend allows ~2 emails a second
    } catch (e) { failed++; console.error('[alerts run]', u.user_id, e.message); }
  }
  console.log('[alerts] done', { users: users?.length || 0, sent, skipped, failed });
  return { sent, skipped, failed };
}
async function cron(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || (req.get('x-cron-secret') || req.query.key) !== secret) return res.status(401).json({ error: 'Unauthorized' });
  if (running) return res.json({ started: false, reason: 'already running' });
  running = true;
  res.json({ started: true }); // answer fast; the emails go out in the background
  runDigest(baseUrl(req)).catch((e) => console.error('[alerts run]', e.message)).finally(() => { running = false; });
}
alertsRouter.get('/cron/alerts', cron);
alertsRouter.post('/cron/alerts', cron);

export const _test = { cleanPrefs, score, rank, buildDigest, sastDate };
