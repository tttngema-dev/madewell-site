import { Router } from 'express';
import crypto from 'node:crypto';
import { supabase } from '../supabase.js';
import { push } from '../notify.js';

export const trackRouter = Router();
export const adminRouter = Router();

// ---------- anonymous visit tracking ----------
const EVENTS = new Set(['visit', 'form_open', 'step', 'pay_click', 'paid_page', 'cancelled']);
const clean = (v, n = 60) => String(v ?? '').replace(/[^\w\-.:/ ]/g, '').slice(0, n);
const hits = new Map();
const limited = (ip) => {
  const now = Date.now(), h = (hits.get(ip) || []).filter((t) => now - t < 6e5);
  h.push(now); hits.set(ip, h); return h.length > 150;
};

trackRouter.post('/track', async (req, res) => {
  res.status(204).end();
  try {
    const { v, e, s, p, src, dev } = req.body || {};
    if (!/^[a-z0-9]{8,40}$/.test(v || '') || !EVENTS.has(e) || limited(req.ip)) return;
    const step = e === 'step' ? Math.min(5, Math.max(1, parseInt(s, 10) || 1)) : null;
    const source = clean(src, 30) || 'direct', device = dev === 'mobile' ? 'mobile' : 'desktop';
    await supabase.from('site_events').insert({ visitor: v, event: e, step, path: clean(p), source, device });
    if (step === 5) {
      const since = new Date(Date.now() - 12 * 36e5).toISOString();
      const { count } = await supabase.from('site_events').select('id', { count: 'exact', head: true }).eq('visitor', v).eq('step', 5).gte('created_at', since);
      if (count === 1) await push('Pay step reached', `Someone reached the pay step (${device === 'mobile' ? 'phone' : 'computer'}, from ${source}).`);
    }
  } catch (err) { console.error('track error:', err.message); }
});

// ---------- password-protected admin API ----------
const fails = new Map();
function auth(req, res, next) {
  const ip = req.ip, f = fails.get(ip) || { n: 0, t: 0 };
  if (Date.now() - f.t > 6e5) f.n = 0;
  if (f.n >= 8) return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
  const pw = process.env.ADMIN_PASSWORD || '';
  const h = (x) => crypto.createHash('sha256').update(x).digest();
  if (!pw || !crypto.timingSafeEqual(h(req.get('x-admin-key') || ''), h(pw))) {
    f.n++; f.t = Date.now(); fails.set(ip, f);
    return res.status(401).json({ error: 'Wrong password' });
  }
  next();
}
adminRouter.use('/admin', auth);

async function fetchAll(build) { // Supabase returns max 1000 rows per request
  let out = [];
  for (let i = 0; i < 10; i++) {
    const { data, error } = await build().range(i * 1000, i * 1000 + 999);
    if (error) throw new Error(error.message);
    out = out.concat(data); if (data.length < 1000) break;
  }
  return out;
}

adminRouter.get('/admin/summary', async (req, res) => {
  try {
    const now = Date.now(), r = req.query.range;
    const sast = new Date(now + 2 * 36e5); sast.setUTCHours(0, 0, 0, 0);
    const since = r === '30d' ? now - 30 * 864e5 : r === '7d' ? now - 7 * 864e5 : sast.getTime() - 2 * 36e5;
    const events = await fetchAll(() => supabase.from('site_events').select('visitor,event,step,source,device,created_at').gte('created_at', new Date(since).toISOString()).order('created_at', { ascending: true }));
    const { data: regs, error } = await supabase.from('company_registrations').select('reference,status,created_at,paid_at,contact_email,work_status,data').order('created_at', { ascending: false }).limit(300);
    if (error) throw new Error(error.message);

    const V = new Map();
    for (const e of events) {
      const t = new Date(e.created_at).getTime();
      const v = V.get(e.visitor) || { id: e.visitor.slice(0, 6), first: t, last: t, source: e.source, device: e.device, max: 0, label: 'Visited only', pages: 0, lastEvent: e.event };
      v.last = t; v.lastEvent = e.event; v.pages++;
      const rank = e.event === 'paid_page' ? 8 : e.event === 'pay_click' ? 7 : e.event === 'step' ? e.step : e.event === 'form_open' ? 0.5 : 0;
      if (rank > v.max) { v.max = rank; v.label = rank === 8 ? 'Reached success page' : rank === 7 ? 'Clicked pay' : rank >= 1 ? `Step ${rank} of 5` : 'Opened the form'; }
      V.set(e.visitor, v);
    }
    const vs = [...V.values()], count = (f) => vs.filter(f).length;
    const funnel = [
      ['Visited the site', vs.length], ['Opened the form', count((v) => v.max >= 0.5)],
      ...[1, 2, 3, 4, 5].map((n) => [n === 5 ? 'Reached the pay step' : `Reached step ${n}`, count((v) => v.max >= n)]),
      ['Clicked pay', count((v) => v.max >= 7)],
    ];
    const paid = (regs || []).filter((x) => x.status === 'paid' && x.paid_at && new Date(x.paid_at).getTime() >= since);
    funnel.push(['Paid (confirmed by PayFast)', paid.length]);
    const sources = {}; vs.forEach((v) => { sources[v.source] = (sources[v.source] || 0) + 1; });
    const live = vs.filter((v) => now - v.last < 3e5);
    res.json({
      generated: now,
      live: { now: live.length, inForm: live.filter((v) => v.max >= 0.5 && v.max < 7).length },
      funnel, sources, revenue: paid.length * 780,
      visitors: vs.sort((a, b) => b.last - a.last).slice(0, 40),
      registrations: (regs || []).map((x) => ({ reference: x.reference, status: x.status, created_at: x.created_at, paid_at: x.paid_at, email: x.contact_email, work: x.work_status || 'new', data: x.data })),
    });
  } catch (err) { console.error('admin summary error:', err.message); res.status(500).json({ error: err.message }); }
});

adminRouter.post('/admin/registration/:ref/status', async (req, res) => {
  const s = req.body?.status;
  if (!['new', 'waiting_docs', 'submitted', 'done'].includes(s)) return res.status(400).json({ error: 'Bad status' });
  const { error } = await supabase.from('company_registrations').update({ work_status: s }).eq('reference', req.params.ref);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});
