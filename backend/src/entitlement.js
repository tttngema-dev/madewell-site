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
 * FREE PLAN: ONE download in total, for the whole site. A blank tender document, OR the finished filled-in PDF, OR emailing it.
 * Exactly once: not the same document again, not another one. Pro: unlimited. Filling in and previewing stay free.
 *
 * If we cannot check (database or SQL problem) a free person is REFUSED, not waved through: a missing table must never
 * turn into unlimited free downloads. (If we cannot even tell whether someone is Pro, we let them through.)
 */
async function proStatus(userId) {
  try { return { pro: isProRow(await getSubscription(userId)), known: true }; }
  catch (err) { console.error('[entitlement] cannot read subscriptions:', err.message); return { pro: false, known: false }; }
}
async function usedFreeDownload(userId) {
  const a = await supabase.from('free_downloads').select('user_id').eq('user_id', userId).maybeSingle();
  if (a.error) throw a.error;
  if (a.data) return true;
  const b = await supabase.from('free_exports').select('user_id').eq('user_id', userId).maybeSingle(); // v15 table: counts too
  return !!(b.data && !b.error);
}
async function useFreeDownload(userId, ocid, docUrl, title) {
  const ins = await supabase.from('free_downloads').insert({ user_id: userId, ocid: String(ocid || ''), doc_url: String(docUrl || ''), doc_title: String(title || '').slice(0, 200) || null });
  if (ins.error && ins.error.code !== '23505') throw ins.error;
  return !ins.error; // false = someone else just used it a moment ago
}

export async function checkDownload(userId, ocid, docUrl, title, opts = {}) {
  const st = await proStatus(userId);
  if (st.pro) return { allowed: true, pro: true };
  if (!st.known) return { allowed: true, unknown: true };
  try {
    if (await usedFreeDownload(userId)) return { allowed: !!opts.claim, used: true };  // a "claim" (a visitor who signs up) is just noted
    if (opts.dry) return { allowed: true, first: true, dry: true };                     // only asking: nothing is used up
    return { allowed: await useFreeDownload(userId, ocid, docUrl, title), first: true };
  } catch (err) {
    console.error('[entitlement] DOWNLOAD LIMIT CHECK FAILED (did you run backend/sql/run_this_once.sql?):', err.message);
    return { allowed: false, error: true };
  }
}

/** The finished (filled-in) PDF, downloaded or emailed, counts as that one free download. peekExport asks, recordExport uses it up. */
export async function peekExport(userId, ocid, docUrl) {
  const st = await proStatus(userId);
  if (st.pro) return { allowed: true, pro: true };
  if (!st.known) return { allowed: true, unknown: true };
  try {
    const access = await checkDocAccess(userId, ocid, docUrl);
    if (!access.allowed) return { allowed: false, reason: 'doc' };
    return { allowed: !(await usedFreeDownload(userId)), reason: 'export' };
  } catch (err) {
    console.error('[entitlement] EXPORT LIMIT CHECK FAILED (did you run backend/sql/run_this_once.sql?):', err.message);
    return { allowed: false, error: true };
  }
}
export async function recordExport(userId, ocid, docUrl, kind) {
  const st = await proStatus(userId);
  if (st.pro || !st.known) return true;
  try { return await useFreeDownload(userId, ocid, docUrl, 'finished document (' + (kind || 'download') + ')'); }
  catch (err) { console.error('[entitlement] could not record the free download:', err.message); return false; }
}
export async function getFreeExport(userId) { return getFreeDownload(userId); }

export async function getFreeDownload(userId) {
  try { return (await usedFreeDownload(userId)) ? { used: true } : null; }
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
