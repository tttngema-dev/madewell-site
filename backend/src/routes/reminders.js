import { Router } from 'express';
import { supabase } from '../supabase.js';

export const remindersRouter = Router();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WA = 'https://wa.me/27672581319';

async function sendReminder(reg) {
  const key = process.env.RESEND_API_KEY, front = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
  if (!key || !front) { console.warn('Reminder not sent: RESEND_API_KEY or FRONTEND_URL missing'); return false; }
  const first = (reg.data?.directors?.[0]?.name || '').split(' ')[0] || 'there';
  const co = reg.data?.names?.[0] || 'your company';
  const link = `${front}/resume.html?ref=${encodeURIComponent(reg.reference)}`;
  const text = `Hi ${first},\n\nYou started registering ${co} with Made Well, and your details are saved. You can finish in about a minute: ${link}\n\nThe fee is a fixed R780, paid securely through PayFast, and registration takes up to 3 business days.\n\nQuestions? WhatsApp us on 067 258 1319: ${WA}\n\nIf you've already paid or don't want to continue, just ignore this email. We won't send another reminder.\n\nMade Well`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#0b1730;line-height:1.6"><h2 style="margin-bottom:0">Your registration is almost done</h2><p>Hi ${esc(first)},</p><p>You started registering <b>${esc(co)}</b>, and your details are saved. You can finish in about a minute.</p><p style="margin:24px 0"><a href="${esc(link)}" style="background:#f5a623;color:#0b1730;padding:14px 26px;border-radius:30px;text-decoration:none;font-weight:bold">Finish my registration</a></p><p>The fee is a fixed <b>R780</b>, paid securely through PayFast. Registration takes up to 3 business days.</p><p>Questions? <a href="${WA}">WhatsApp us on 067 258 1319</a>.</p><p style="color:#667;font-size:13px">If you've already paid or don't want to continue, just ignore this email. We won't send another reminder.</p></div>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.FROM_EMAIL || 'Made Well <onboarding@resend.dev>', to: [reg.contact_email], reply_to: process.env.NOTIFY_EMAIL || undefined, subject: 'Your company registration is almost done', text, html }),
  });
  if (!res.ok) { console.error('Reminder email error:', res.status, await res.text()); return false; }
  return true;
}

// Call this every 30 minutes from a free scheduler (e.g. cron-job.org). It also keeps Render awake.
async function run(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || (req.get('x-cron-secret') || req.query.key) !== secret) return res.status(401).json({ error: 'Unauthorized' });
  const now = Date.now();
  const { data: rows, error } = await supabase.from('company_registrations')
    .select('reference,contact_email,created_at,data').eq('status', 'awaiting_payment').is('reminded_at', null)
    .gte('created_at', new Date(now - 48 * 36e5).toISOString()).lte('created_at', new Date(now - 60 * 6e4).toISOString())
    .order('created_at', { ascending: false }).limit(50);
  if (error) { console.error('Reminder query error:', error.message); return res.status(500).json({ error: error.message }); }
  const seen = new Set(); let sent = 0, skipped = 0;
  for (const r of rows || []) {
    const mark = () => supabase.from('company_registrations').update({ reminded_at: new Date().toISOString() }).eq('reference', r.reference).is('reminded_at', null);
    const email = (r.contact_email || '').toLowerCase();
    if (!email || seen.has(email)) { await mark(); skipped++; continue; }
    seen.add(email);
    const { data: paid } = await supabase.from('company_registrations').select('reference').eq('contact_email', r.contact_email).eq('status', 'paid').limit(1);
    if (paid?.length) { await mark(); skipped++; continue; }
    if (await sendReminder(r)) { await mark(); sent++; }
  }
  res.json({ checked: rows?.length || 0, sent, skipped });
}
remindersRouter.get('/cron/reminders', run);
remindersRouter.post('/cron/reminders', run);
