/**
 * Who has Pro, and who may use which feature.
 *
 *  FREE  : browse tenders, download the blank documents, save tenders, company profile + documents + signature,
 *          and ONE document they can fill in, attach to, download and email (the "free trial document").
 *  PRO   : R199 / month (PayFast subscription) or a promo code. Unlimited documents + tender alert emails.
 *
 * The free trial document is simply the first document the person ever saved a fill-in for.
 */
import { supabase } from './supabase.js';

export const PRICE = 199; // rand per month. Change it here and everything (PayFast, the paywall, the admin page) follows.
export const PRICE_TEXT = PRICE.toFixed(2);
const GRACE_MS = 2 * 864e5; // PayFast's monthly notification can arrive a day late; don't lock paying people out meanwhile

export function isProRow(row, now = Date.now()) {
  if (!row) return false;
  if (row.status !== 'active' && row.status !== 'cancelled') return false;
  if (!row.current_period_end) return row.source === 'promo' && row.status === 'active'; // free with no end date
  const end = new Date(row.current_period_end).getTime();
  const grace = row.source === 'payfast' && row.status === 'active' ? GRACE_MS : 0;
  return end + grace > now;
}

export async function getSubscription(userId) {
  const { data, error } = await supabase.from('subscriptions').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data || null;
}

/** The document this person may fill in for free (their first one), or null if they haven't started yet. */
export async function getTrialDoc(userId) {
  const { data, error } = await supabase.from('tender_doc_edits').select('ocid, doc_url, doc_title, created_at')
    .eq('user_id', userId).order('created_at', { ascending: true }).limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

/**
 * May this person fill in / save / email THIS document?
 * If we can't tell (database hiccup, SQL not run yet) we let them through and log it:
 * wrongly blocking a paying customer is worse than letting a free user slip through for a minute.
 */
export async function checkDocAccess(userId, ocid, docUrl) {
  try {
    const sub = await getSubscription(userId);
    if (isProRow(sub)) return { allowed: true, pro: true, sub };
    const trial = await getTrialDoc(userId);
    if (!trial) return { allowed: true, pro: false, trialDoc: null, sub };                       // first document ever: free
    if (trial.ocid === String(ocid) && trial.doc_url === String(docUrl)) return { allowed: true, pro: false, trialDoc: trial, sub };
    return { allowed: false, pro: false, trialDoc: trial, sub };
  } catch (err) {
    console.error('[entitlement] doc access check failed, allowing:', err.message);
    return { allowed: true, pro: false, unknown: true };
  }
}

/**
 * Free plan: ONE tender document download in total. Exactly once: not the same document again, not another one.
 * Pro: unlimited. { claim: true } only records a download that a signed-out visitor already made in their browser
 * (so signing up does not give a second free one). If we can't tell (database hiccup, SQL not run yet) we let it through and log it.
 */
export async function checkDownload(userId, ocid, docUrl, title, opts = {}) {
  try {
    const sub = await getSubscription(userId);
    if (isProRow(sub)) return { allowed: true, pro: true };
    const { data, error } = await supabase.from('free_downloads').select('ocid').eq('user_id', userId).maybeSingle();
    if (error) throw error;
    if (data) return { allowed: !!opts.claim, used: true };   // already used: a claim is simply "noted", a real download is refused
    const ins = await supabase.from('free_downloads').insert({ user_id: userId, ocid: String(ocid || ''), doc_url: String(docUrl || ''), doc_title: String(title || '').slice(0, 200) || null });
    if (ins.error && ins.error.code !== '23505') throw ins.error;
    return { allowed: true, first: true };
  } catch (err) {
    console.error('[entitlement] download check failed, allowing:', err.message);
    return { allowed: true, unknown: true };
  }
}

/**
 * Free plan: ONE finished filled-in document (downloaded OR emailed), and only for their one free fill-in document.
 * peekExport() asks; recordExport() uses it up (after the email was really sent, or when the download is handed over).
 */
export async function peekExport(userId, ocid, docUrl) {
  try {
    const sub = await getSubscription(userId);
    if (isProRow(sub)) return { allowed: true, pro: true };
    const access = await checkDocAccess(userId, ocid, docUrl);
    if (!access.allowed) return { allowed: false, reason: 'doc' };
    const { data, error } = await supabase.from('free_exports').select('user_id').eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return { allowed: !data, reason: data ? 'export' : null };
  } catch (err) {
    console.error('[entitlement] export check failed, allowing:', err.message);
    return { allowed: true, unknown: true };
  }
}
export async function recordExport(userId, ocid, docUrl, kind) {
  try {
    const sub = await getSubscription(userId);
    if (isProRow(sub)) return;
    const r = await supabase.from('free_exports').insert({ user_id: userId, ocid: String(ocid || ''), doc_url: String(docUrl || ''), kind: kind || null });
    if (r.error && r.error.code !== '23505') throw r.error;
  } catch (err) { console.error('[entitlement] could not record export:', err.message); }
}
export async function getFreeExport(userId) {
  try { const { data } = await supabase.from('free_exports').select('kind').eq('user_id', userId).maybeSingle(); return data || null; }
  catch (_) { return null; }
}

export async function getFreeDownload(userId) {
  try { const { data } = await supabase.from('free_downloads').select('ocid, doc_url, doc_title').eq('user_id', userId).maybeSingle(); return data || null; }
  catch (_) { return null; }
}

export async function isPro(userId) {
  try { return isProRow(await getSubscription(userId)); }
  catch (err) { console.error('[entitlement] pro check failed, allowing:', err.message); return true; }
}

/** Every user id that currently has Pro (used by the daily alert emails). */
export async function proUserIds() {
  const { data, error } = await supabase.from('subscriptions').select('*').in('status', ['active', 'cancelled']).limit(20000);
  if (error) throw error;
  return new Set((data || []).filter((r) => isProRow(r)).map((r) => r.user_id));
}

export const PRO_REQUIRED = { ok: false, code: 'pro_required', error: 'This is part of Made Well Pro.' };
