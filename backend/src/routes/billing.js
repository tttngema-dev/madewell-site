/**
 * Made Well Pro: plan status, subscribe (PayFast), promo codes, cancel, and the admin promo-code tools.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { supabase } from '../supabase.js';
import { adminRouter } from './admin.js';
import { buildSubscription, cancelPayfastSubscription } from '../payfast.js';
import { PRICE, getSubscription, getTrialDoc, isProRow, checkDocAccess } from '../entitlement.js';

export const billingRouter = Router();

const codeLimits = new Map();
function tooManyCodeTries(userId) {
  const now = Date.now(), arr = (codeLimits.get(userId) || []).filter((t) => now - t < 15 * 60e3);
  arr.push(now); codeLimits.set(userId, arr);
  return arr.length > 8; // 8 guesses per 15 minutes
}

function publicSub(sub) {
  if (!sub) return null;
  return {
    source: sub.source, status: sub.status, promo_code: sub.source === 'promo' ? sub.promo_code : null,
    current_period_end: sub.current_period_end, lifetime: sub.source === 'promo' && !sub.current_period_end,
  };
}

// GET /api/billing/status[?ocid=..&doc_url=..]
billingRouter.get('/billing/status', requireAuth, async (req, res) => {
  try {
    const sub = await getSubscription(req.user.id);
    const pro = isProRow(sub);
    const trial = await getTrialDoc(req.user.id);
    const out = {
      ok: true, price: PRICE, pro, subscription: publicSub(sub),
      trial: { used: !!trial, doc: trial ? { ocid: trial.ocid, doc_url: trial.doc_url, doc_title: trial.doc_title } : null },
    };
    if (req.query.ocid && req.query.doc_url) {
      out.can_open = pro || !trial || (trial.ocid === String(req.query.ocid) && trial.doc_url === String(req.query.doc_url));
    }
    res.json(out);
  } catch (err) {
    console.error('[billing status]', err.message);
    res.status(500).json({ ok: false, error: 'Could not load your plan. Run backend/sql/subscriptions.sql in Supabase.' });
  }
});

// POST /api/billing/subscribe  -> the signed PayFast form the browser posts
billingRouter.post('/billing/subscribe', requireAuth, async (req, res) => {
  try {
    if (!process.env.PAYFAST_MERCHANT_ID || !process.env.PAYFAST_MERCHANT_KEY) return res.status(503).json({ ok: false, error: 'Payments are not set up on the server yet.' });
    const sub = await getSubscription(req.user.id);
    if (isProRow(sub) && sub.source === 'promo' && !sub.current_period_end) return res.status(400).json({ ok: false, error: 'You already have free Pro access with no end date.' });
    if (isProRow(sub) && sub.source === 'payfast' && sub.status === 'active') return res.status(400).json({ ok: false, error: 'You already have an active Pro subscription.' });
    res.json({ ok: true, payment: buildSubscription(req.user) });
  } catch (err) {
    console.error('[billing subscribe]', err.message);
    res.status(500).json({ ok: false, error: 'Could not start the payment. Please try again.' });
  }
});

// POST /api/billing/redeem  { code }
billingRouter.post('/billing/redeem', requireAuth, async (req, res) => {
  try {
    const code = String(req.body?.code || '').trim().slice(0, 40);
    if (!code) return res.status(400).json({ ok: false, error: 'Type your promo code first.' });
    if (tooManyCodeTries(req.user.id)) return res.status(429).json({ ok: false, error: 'Too many tries. Please wait a few minutes and try again.' });
    const { data, error } = await supabase.rpc('redeem_promo', { p_user: req.user.id, p_email: req.user.email || null, p_code: code });
    if (error) throw error;
    if (!data?.ok) return res.status(400).json({ ok: false, error: data?.error || 'That code did not work.' });
    res.json({ ok: true, ends: data.ends, lifetime: !!data.lifetime, days: data.days });
  } catch (err) {
    console.error('[billing redeem]', err.message);
    res.status(500).json({ ok: false, error: 'Could not check the code right now. Run backend/sql/subscriptions.sql in Supabase, then try again.' });
  }
});

// POST /api/billing/cancel  (keeps Pro until the month that is already paid for ends)
billingRouter.post('/billing/cancel', requireAuth, async (req, res) => {
  try {
    const sub = await getSubscription(req.user.id);
    if (!sub || sub.source !== 'payfast' || sub.status !== 'active') return res.status(400).json({ ok: false, error: 'There is no active subscription to cancel.' });
    if (sub.payfast_token) {
      const ok = await cancelPayfastSubscription(sub.payfast_token);
      if (!ok) return res.status(502).json({ ok: false, error: 'We could not cancel it automatically. You can cancel from your PayFast account, or email us and we will do it straight away.' });
    }
    await supabase.from('subscriptions').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('user_id', req.user.id);
    res.json({ ok: true, ends: sub.current_period_end });
  } catch (err) {
    console.error('[billing cancel]', err.message);
    res.status(500).json({ ok: false, error: 'Could not cancel. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Admin: promo codes + a quick look at subscribers  (protected by the existing admin password)
// ---------------------------------------------------------------------------
const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30);

adminRouter.get('/admin/pro', async (_req, res) => {
  try {
    const { data: codes, error } = await supabase.from('promo_codes').select('*').order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    const { data: subs, error: e2 } = await supabase.from('subscriptions').select('*').order('updated_at', { ascending: false }).limit(500);
    if (e2) throw e2;
    const active = (subs || []).filter((r) => isProRow(r));
    res.json({
      ok: true, price: PRICE,
      counts: { paying: active.filter((r) => r.source === 'payfast' && r.status === 'active').length, promo: active.filter((r) => r.source === 'promo').length, cancelling: active.filter((r) => r.status === 'cancelled').length },
      mrr: active.filter((r) => r.source === 'payfast' && r.status === 'active').length * PRICE,
      codes: codes || [],
      people: (subs || []).slice(0, 60).map((r) => ({ email: r.email, source: r.source, status: r.status, pro: isProRow(r), until: r.current_period_end, code: r.promo_code })),
    });
  } catch (err) { console.error('[admin pro]', err.message); res.status(500).json({ error: err.message }); }
});

adminRouter.post('/admin/promos', async (req, res) => {
  try {
    const b = req.body || {};
    const code = cleanCode(b.code);
    if (code.length < 4) return res.status(400).json({ error: 'The code needs at least 4 letters or numbers.' });
    const days = b.days === '' || b.days == null ? null : Math.max(1, Math.min(3650, parseInt(b.days, 10) || 0));
    if (b.days !== '' && b.days != null && !days) return res.status(400).json({ error: 'Days must be a number.' });
    const max = b.max_uses === '' || b.max_uses == null ? null : Math.max(1, parseInt(b.max_uses, 10) || 0);
    const exp = b.expires_at ? new Date(b.expires_at + 'T23:59:59+02:00') : null;
    if (exp && isNaN(exp)) return res.status(400).json({ error: 'That expiry date is not valid.' });
    const { error } = await supabase.from('promo_codes').insert({ code, days, max_uses: max, expires_at: exp ? exp.toISOString() : null, note: String(b.note || '').slice(0, 120) || null });
    if (error) return res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'That code already exists.' : error.message });
    res.json({ ok: true, code });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

adminRouter.post('/admin/promos/:code/active', async (req, res) => {
  const { error } = await supabase.from('promo_codes').update({ active: !!req.body?.active }).eq('code', cleanCode(req.params.code));
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

export { checkDocAccess };
