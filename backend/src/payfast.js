import express, { Router } from 'express';
import crypto from 'node:crypto';
import { supabase } from './supabase.js';
import { sendRegistrationEmail, sendReceiptEmail } from './email.js';

export const FEE = '780.00'; // Company registration price (ZAR). Set here, never taken from the browser.
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
export function buildPayment(reg) {
  const [first, ...rest] = (reg.data.directors[0]?.name || 'Customer').split(' ');
  const pairs = [
    ['merchant_id', process.env.PAYFAST_MERCHANT_ID],
    ['merchant_key', process.env.PAYFAST_MERCHANT_KEY],
    ['return_url', `${process.env.FRONTEND_URL}/payment-success.html?ref=${reg.reference}`],
    ['cancel_url', `${process.env.FRONTEND_URL}/payment-cancelled.html?ref=${reg.reference}`],
    ['notify_url', `${process.env.BACKEND_URL}/api/payfast/itn`],
    ['name_first', first],
    ['name_last', rest.join(' ')],
    ['email_address', reg.contact_email],
    ['m_payment_id', reg.reference],
    ['amount', FEE],
    ['item_name', 'Company registration (Pty) Ltd'],
    ['item_description', `Made Well registration ${reg.reference}`],
  ].filter(([, v]) => String(v ?? '').trim() !== '');
  return { url: `https://${HOST}/eng/process`, fields: { ...Object.fromEntries(pairs), signature: sign(pairs, true) } };
}

export const payfastRouter = Router();

// PayFast's Instant Transaction Notification: the ONLY thing that marks an order as paid.
payfastRouter.post('/payfast/itn', express.urlencoded({ extended: false }), async (req, res) => {
  res.sendStatus(200); // acknowledge immediately; PayFast retries if it doesn't get a 200
  try {
    const body = req.body || {};
    const pairs = Object.entries(body).filter(([k]) => k !== 'signature');

    if (sign(pairs, false) !== body.signature) return console.warn('ITN rejected: bad signature');

    const { data: reg } = await supabase.from('company_registrations').select('*').eq('reference', body.m_payment_id).maybeSingle();
    if (!reg) return console.warn('ITN rejected: unknown reference', body.m_payment_id);
    if (Math.abs(parseFloat(body.amount_gross) - parseFloat(FEE)) > 0.01) return console.warn('ITN rejected: wrong amount', body.amount_gross);

    // Ask PayFast to confirm it really sent this
    const check = await fetch(`https://${HOST}/eng/query/validate`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: paramString(pairs, false),
    });
    if ((await check.text()).trim() !== 'VALID') return console.warn('ITN rejected: PayFast did not confirm');

    if (body.payment_status !== 'COMPLETE') return console.log('ITN status:', body.payment_status, reg.reference);

    // Only the first successful notification flips the status, so you get one email, not several
    const { data: updated } = await supabase.from('company_registrations')
      .update({ status: 'paid', paid_at: new Date().toISOString(), pf_payment_id: body.pf_payment_id })
      .eq('reference', reg.reference).eq('status', 'awaiting_payment').select('reference');
    if (updated?.length) {
      // Two separate emails: a failure of one must not stop the other
      try { await sendRegistrationEmail(reg.reference, reg.data, true); } catch (e) { console.error('owner email failed:', e.message); }
      try { await sendReceiptEmail(reg, body.pf_payment_id); } catch (e) { console.error('receipt email failed:', e.message); }
    }
  } catch (e) {
    console.error('ITN error:', e.message);
  }
});
