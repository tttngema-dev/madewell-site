import express, { Router } from 'express';
import crypto from 'node:crypto';
import { supabase } from './supabase.js';
import { sendRegistrationEmail, sendReceiptEmail, sendBoEmail, sendBoReceipt } from './email.js';
import { push } from './notify.js';
import { PRICE_TEXT } from './entitlement.js';

export const FEE_BO = '500.00'; // Beneficial ownership filing price (ZAR)
export const FEE = '580.00'; // Company registration price (ZAR). Set here, never taken from the browser.
const HOST = process.env.PAYFAST_SANDBOX === 'true' ? 'sandbox.payfast.co.za' : 'www.payfast.co.za';

// PayFast expects PHP-style urlencoding: uppercase hex, spaces as "+"
const enc = (v) =>
  encodeURIComponent(String(v).trim()).replace(/%20/g, '+').replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

const paramString = (pairs, skipEmpty) =>
  pairs.filter(([, v]) => !skipEmpty || String(v ?? '').trim() !== '').map(([k, v]) => `${k}=${enc(v ?? '')}`).join('&');

const sign = (pairs, skipEmpty) => {
  let s = paramString(pairs, skipEmpty);
  if (process.env.PAYFAST_PASSPHRASE) s += `&passphrase=${enc(process.env.PAYFAST_PASSPHRASE)}`;
  return crypto.createHash('md5').update(s).digest('hex');
};

// Build the signed form the browser posts to PayFast. Field ORDER matters for the signature.
export function buildPayment(reg, o = {}) {
  const [first, ...rest] = (o.payer || reg.data?.directors?.[0]?.name || 'Customer').split(' ');
  const pairs = [
    ['merchant_id', process.env.PAYFAST_MERCHANT_ID],
    ['merchant_key', process.env.PAYFAST_MERCHANT_KEY],
    ['return_url', `${process.env.FRONTEND_URL}/${o.ok || 'payment-success.html'}?ref=${reg.reference}`],
    ['cancel_url', `${process.env.FRONTEND_URL}/${o.cancel || 'payment-cancelled.html'}?ref=${reg.reference}`],
    ['notify_url', `${process.env.BACKEND_URL}/api/payfast/itn`],
    ['name_first', first],
    ['name_last', rest.join(' ')],
    ['email_address', reg.contact_email],
    ['m_payment_id', reg.reference],
    ['amount', o.amount || FEE],
    ['item_name', o.item || 'Company registration (Pty) Ltd'],
    ['item_description', o.desc || `Made Well registration ${reg.reference}`],
  ].filter(([, v]) => String(v ?? '').trim() !== '');
  console.log('PayFast payment created:', reg.reference, '| notify_url =', pairs.find(([k]) => k === 'notify_url')?.[1], '| sandbox =', HOST.startsWith('sandbox'));
  return { url: `https://${HOST}/eng/process`, fields: { ...Object.fromEntries(pairs), signature: sign(pairs, true) } };
}


// ---------------------------------------------------------------------------
// Made Well Pro: a monthly PayFast subscription (R199 / month, runs until the customer cancels)
// ---------------------------------------------------------------------------
const sastToday = () => new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10); // South Africa = UTC+2, no DST

export function buildSubscription(user) {
  const ref = `SUB-${String(user.id).replace(/-/g, '').slice(0, 12)}-${Date.now().toString(36)}`;
  const front = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
  // Field ORDER matters for the signature: PayFast's documented order, subscription fields last.
  const pairs = [
    ['merchant_id', process.env.PAYFAST_MERCHANT_ID],
    ['merchant_key', process.env.PAYFAST_MERCHANT_KEY],
    ['return_url', `${front}/dashboard.html?subscribed=1`],
    ['cancel_url', `${front}/dashboard.html?subscribe=cancelled`],
    ['notify_url', `${process.env.BACKEND_URL}/api/payfast/itn`],
    ['email_address', user.email],
    ['m_payment_id', ref],
    ['amount', PRICE_TEXT],
    ['item_name', 'Made Well Pro (monthly)'],
    ['item_description', 'Made Well Pro: unlimited tender documents and daily tender alerts'],
    ['custom_str1', user.id],
    ['subscription_type', '1'],
    ['billing_date', sastToday()],
    ['recurring_amount', PRICE_TEXT],
    ['frequency', '3'], // 3 = monthly
    ['cycles', '0'],    // 0 = until cancelled
  ].filter(([, v]) => String(v ?? '').trim() !== '');
  console.log('PayFast subscription created:', ref, '| sandbox =', HOST.startsWith('sandbox'));
  return { url: `https://${HOST}/eng/process`, fields: { ...Object.fromEntries(pairs), signature: sign(pairs, true) } };
}

/** Stops future monthly charges. Returns true on success. (PayFast API v1) */
export async function cancelPayfastSubscription(token) {
  const headers = { 'merchant-id': process.env.PAYFAST_MERCHANT_ID, version: 'v1', timestamp: new Date().toISOString().slice(0, 19) };
  const all = { ...headers };
  if (process.env.PAYFAST_PASSPHRASE) all.passphrase = process.env.PAYFAST_PASSPHRASE;
  const str = Object.keys(all).sort().map((k) => `${k}=${enc(all[k])}`).join('&');
  const signature = crypto.createHash('md5').update(str).digest('hex');
  const sandbox = HOST.startsWith('sandbox') ? '?testing=true' : '';
  const r = await fetch(`https://api.payfast.co.za/subscriptions/${encodeURIComponent(token)}/cancel${sandbox}`, { method: 'PUT', headers: { ...headers, signature } });
  const text = await r.text();
  if (!r.ok) console.error('PayFast cancel failed:', r.status, text.slice(0, 300));
  return r.ok;
}

// A subscription payment (first one or each monthly one) or a cancellation notice
async function handleSubscriptionItn(body, pairs) {
  // Ask PayFast to confirm it really sent this
  const check = await fetch(`https://${HOST}/eng/query/validate`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: paramString(pairs, false),
  });
  if ((await check.text()).trim() !== 'VALID') return console.warn('Subscription ITN rejected: PayFast did not confirm');

  // Who is it? The first payment carries our user id; later monthly ones are matched by PayFast's subscription token.
  let userId = /^[0-9a-f-]{36}$/i.test(body.custom_str1 || '') ? body.custom_str1 : null;
  let { data: row } = userId
    ? await supabase.from('subscriptions').select('*').eq('user_id', userId).maybeSingle()
    : body.token ? await supabase.from('subscriptions').select('*').eq('payfast_token', body.token).maybeSingle() : { data: null };
  if (!userId && row) userId = row.user_id;
  if (!userId) return console.warn('Subscription ITN rejected: cannot tell which user', body.m_payment_id);

  if (body.payment_status === 'CANCELLED') {
    await supabase.from('subscriptions').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('user_id', userId).eq('source', 'payfast');
    console.log('Subscription cancelled (access stays until the paid month ends):', userId);
    return;
  }
  if (body.payment_status !== 'COMPLETE') return console.log('Subscription ITN status:', body.payment_status, userId);
  if (Math.abs(parseFloat(body.amount_gross) - parseFloat(PRICE_TEXT)) > 0.01) return console.warn('Subscription ITN rejected: wrong amount', body.amount_gross);
  if (row && row.last_pf_payment_id && row.last_pf_payment_id === body.pf_payment_id) return console.log('Subscription ITN already processed', body.pf_payment_id);

  // One more month on top of whatever is still left
  const now = Date.now();
  const left = row && row.current_period_end ? new Date(row.current_period_end).getTime() : 0;
  const end = new Date(Math.max(now, left) + 31 * 864e5).toISOString();
  const { data: authUser } = await supabase.auth.admin.getUserById(userId).catch(() => ({ data: null }));
  const { error } = await supabase.from('subscriptions').upsert({
    user_id: userId, source: 'payfast', status: 'active', plan: 'pro', current_period_end: end,
    payfast_token: body.token || (row && row.payfast_token) || null, last_pf_payment_id: body.pf_payment_id || null,
    last_paid_at: new Date().toISOString(), email: authUser?.user?.email || (row && row.email) || body.email_address || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (error) return console.error('Subscription ITN: could not save. Supabase said:', error.message);
  console.log('Subscription payment accepted:', userId, 'Pro until', end);
  try { await push(row ? 'Pro renewed' : 'New Pro subscriber', `R${PRICE_TEXT} received from ${authUser?.user?.email || userId}.`); } catch (e) { /* ignore */ }
}

export const payfastRouter = Router();

// Open this address in a browser to check the route is deployed and reachable
payfastRouter.get('/payfast/itn', (_req, res) => res.send('PayFast ITN endpoint is live'));

// PayFast's Instant Transaction Notification: the ONLY thing that marks an order as paid.
payfastRouter.post('/payfast/itn', express.urlencoded({ extended: false }), async (req, res) => {
  res.sendStatus(200); // acknowledge immediately; PayFast retries if it doesn't get a 200
  try {
    const body = req.body || {};
    console.log('ITN received:', body.m_payment_id, body.payment_status);
    const pairs = Object.entries(body).filter(([k]) => k !== 'signature');

    if (sign(pairs, false) !== body.signature) return console.warn('ITN rejected: bad signature');

    // Made Well Pro subscription payments (m_payment_id starts with SUB-, or PayFast's monthly notices carrying our token)
    let isSub = String(body.m_payment_id || '').startsWith('SUB-');
    if (!isSub && body.token) {
      const { data: known } = await supabase.from('subscriptions').select('user_id').eq('payfast_token', body.token).maybeSingle();
      isSub = !!known;
    }
    if (isSub) return await handleSubscriptionItn(body, pairs);

    const isBo = String(body.m_payment_id || '').startsWith('BO-'), table = isBo ? 'bo_filings' : 'company_registrations';
    const { data: reg } = await supabase.from(table).select('*').eq('reference', body.m_payment_id).maybeSingle();
    if (!reg) return console.warn('ITN rejected: unknown reference', body.m_payment_id);
    if (Math.abs(parseFloat(body.amount_gross) - parseFloat(isBo ? FEE_BO : FEE)) > 0.01) return console.warn('ITN rejected: wrong amount', body.amount_gross);

    // Ask PayFast to confirm it really sent this
    const check = await fetch(`https://${HOST}/eng/query/validate`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: paramString(pairs, false),
    });
    if ((await check.text()).trim() !== 'VALID') return console.warn('ITN rejected: PayFast did not confirm');

    if (body.payment_status !== 'COMPLETE') return console.log('ITN status:', body.payment_status, reg.reference);

    // Only the first successful notification flips the status, so you get one email, not several
    const { data: updated, error: updErr } = await supabase.from(table)
      .update({ status: 'paid', paid_at: new Date().toISOString(), pf_payment_id: body.pf_payment_id })
      .eq('reference', reg.reference).eq('status', 'awaiting_payment').select('reference');
    if (updErr) return console.error('ITN: could not mark as paid. Supabase said:', updErr.message);
    console.log('ITN accepted:', reg.reference, updated?.length ? 'marked paid' : 'already processed');
    if (updated?.length && isBo) {
      try { await processBoPaid(reg, body.pf_payment_id); } catch (e) { console.error('BO processing failed:', e.message); }
      try { await push('Beneficial ownership paid', `R500 paid. Ref ${reg.reference}`); } catch (e) { /* ignore */ }
    } else if (updated?.length) {
      // Two separate emails: a failure of one must not stop the other
      try { await sendRegistrationEmail(reg.reference, reg.data, true); } catch (e) { console.error('owner email failed:', e.message); }
      try { await sendReceiptEmail(reg, body.pf_payment_id); } catch (e) { console.error('receipt email failed:', e.message); }
      try { await push('Payment received', `R580 paid. Ref ${reg.reference}`); } catch (e) { /* ignore */ }
    }
  } catch (e) {
    console.error('ITN error:', e.message);
  }
});

// After a beneficial ownership payment: email the team the PDFs and ID copies, email the customer a receipt, then delete the files.
async function processBoPaid(reg, pfId) {
  const { data: files } = await supabase.from('bo_files').select('kind,owner,name,mime,data').eq('reference', reg.reference);
  const sent = await sendBoEmail(reg.reference, reg.data, files || [], pfId);
  try { await sendBoReceipt(reg, files || [], pfId); } catch (e) { console.error('BO receipt email failed:', e.message); }
  if (sent) await supabase.from('bo_files').delete().eq('reference', reg.reference); // keep ID copies only as long as needed
  else console.error('BO email to team failed; files kept so nothing is lost:', reg.reference);
}
