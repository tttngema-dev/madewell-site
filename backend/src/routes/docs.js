/**
 * Tender documents: inline preview proxy, saved fill-in state, and "email this document".
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { supabase } from '../supabase.js';
import { fetchDocument, isAllowedUrl, looksLikePdf } from '../docProxy.js';
import { checkDocAccess, PRO_REQUIRED } from '../entitlement.js';

const router = Router();

// ---- tiny in-memory rate limiter (per key, sliding window) ----
function makeLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return false; }
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    return true;
  };
}
const proxyLimit = makeLimiter(40, 60 * 1000);
const emailLimit = makeLimiter(15, 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// GET /api/doc-proxy?url=...   (public, allow-listed hosts only)
// ---------------------------------------------------------------------------
router.get('/doc-proxy', async (req, res) => {
  if (!proxyLimit(req.ip)) return res.status(429).json({ ok: false, error: 'Too many requests. Please wait a moment.' });
  const url = String(req.query.url || '');
  if (!isAllowedUrl(url)) return res.status(400).json({ ok: false, error: 'That document link is not supported for preview.' });
  try {
    const doc = await fetchDocument(url);
    const pdf = looksLikePdf(doc.buffer);
    res.set({
      'Content-Type': pdf ? 'application/pdf' : 'application/octet-stream',
      'Content-Disposition': pdf ? 'inline; filename="document.pdf"' : 'attachment',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=300',
    });
    res.send(doc.buffer);
  } catch (err) {
    console.error('[doc-proxy]', err.code || '', err.message);
    const msg =
      err.code === 'too_large' ? 'This file is too large to preview. Please download it instead.'
        : err.code === 'not_allowed' ? 'That document link is not supported for preview.'
          : 'Could not fetch the document from the source. Try the download link instead.';
    res.status(err.code === 'too_large' ? 413 : 502).json({ ok: false, error: msg });
  }
});

// ---------------------------------------------------------------------------
// Saved fill-in state  (one row per user + tender + document)
// ---------------------------------------------------------------------------
const MAX_STATE_BYTES = 700 * 1024;

router.get('/account/doc-edits', requireAuth, async (req, res) => {
  try {
    const docUrl = req.query.doc_url ? String(req.query.doc_url) : null;
    let q = supabase.from('tender_doc_edits').select(docUrl ? '*' : 'id, ocid, doc_url, doc_title, updated_at').eq('user_id', req.user.id);
    if (req.query.ocid) q = q.eq('ocid', String(req.query.ocid));
    if (docUrl) q = q.eq('doc_url', docUrl);
    const { data, error } = await q.order('updated_at', { ascending: false });
    if (error) throw error;
    res.json({ ok: true, items: data || [] });
  } catch (err) {
    console.error('[doc-edits get]', err.message);
    res.status(500).json({ ok: false, error: 'Could not load saved documents. Run backend/sql/doc_editor.sql in Supabase.' });
  }
});

router.put('/account/doc-edits', requireAuth, async (req, res) => {
  try {
    const { ocid, doc_url, doc_title, state } = req.body || {};
    if (!ocid || !doc_url || typeof state !== 'object' || state === null) {
      return res.status(400).json({ ok: false, error: 'ocid, doc_url and state are required' });
    }
    if (JSON.stringify(state).length > MAX_STATE_BYTES) {
      return res.status(413).json({ ok: false, error: 'Too much content to save' });
    }
    // Free plan: one document. Anything beyond it is Pro.
    const access = await checkDocAccess(req.user.id, ocid, doc_url);
    if (!access.allowed) return res.status(402).json({ ...PRO_REQUIRED, reason: 'doc', error: 'Your free document is used up. Go Pro to fill in more.' });
    const row = {
      user_id: req.user.id,
      ocid: String(ocid),
      doc_url: String(doc_url),
      doc_title: doc_title ? String(doc_title).slice(0, 300) : null,
      state,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase
      .from('tender_doc_edits')
      .upsert(row, { onConflict: 'user_id,ocid,doc_url' })
      .select('id, updated_at')
      .single();
    if (error) throw error;
    res.json({ ok: true, id: data.id, updated_at: data.updated_at });
  } catch (err) {
    console.error('[doc-edits put]', err.message);
    res.status(500).json({ ok: false, error: 'Could not save. Run backend/sql/doc_editor.sql in Supabase.' });
  }
});

router.delete('/account/doc-edits/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('tender_doc_edits').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[doc-edits delete]', err.message);
    res.status(500).json({ ok: false, error: 'Could not delete' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/account/docs/email   (signed-in users; PDF is sent as an attachment)
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;
const MAX_PDF_BYTES = 12 * 1024 * 1024;

function parseRecipients(v) {
  const list = (Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/)).map((s) => String(s).trim()).filter(Boolean);
  return [...new Set(list.map((s) => s.toLowerCase()))];
}

router.post('/account/docs/email', requireAuth, async (req, res) => {
  try {
    const key = process.env.RESEND_API_KEY;
    if (!key) return res.status(503).json({ ok: false, error: 'Email sending is not set up on the server yet.' });
    if (!emailLimit(req.user.id)) return res.status(429).json({ ok: false, error: 'You have sent a lot of emails in the last hour. Please try again later.' });

    const b = req.body || {};
    const access = await checkDocAccess(req.user.id, b.ocid, b.doc_url);
    if (!access.allowed || (!access.pro && !b.ocid)) return res.status(402).json({ ...PRO_REQUIRED, reason: 'doc', error: 'Emailing documents is part of Made Well Pro.' });
    const to = parseRecipients(b.to);
    if (!to.length) return res.status(400).json({ ok: false, error: 'Enter an email address to send to.' });
    if (to.length > 5) return res.status(400).json({ ok: false, error: 'You can send to at most 5 addresses at a time.' });
    const bad = to.find((a) => !EMAIL_RE.test(a));
    if (bad) return res.status(400).json({ ok: false, error: `“${bad}” doesn’t look like a valid email address.` });

    const b64 = String(b.pdf_base64 || '').replace(/^data:application\/pdf;base64,/, '');
    const pdf = Buffer.from(b64, 'base64');
    if (!pdf.length || !pdf.subarray(0, 8).toString('latin1').startsWith('%PDF')) {
      return res.status(400).json({ ok: false, error: 'The document could not be read. Please try again.' });
    }
    if (pdf.length > MAX_PDF_BYTES) return res.status(413).json({ ok: false, error: 'The document is too large to email (12 MB limit). Download it and send it yourself.' });

    const safeName = (String(b.filename || 'tender-document').replace(/\.pdf$/i, '').replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'tender-document') + '.pdf';
    const subject = String(b.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || `Tender document: ${safeName}`;
    const message = String(b.message || '').slice(0, 5000);
    const cc = b.cc_me && req.user.email ? [req.user.email] : [];
    const sender = req.user.email || '';

    const text = [message, '', `— Sent from Made Well on behalf of ${sender}. Reply to this email to reach them directly.`].join('\n').trim();
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1d1d1d;max-width:600px;line-height:1.55">
      ${message ? `<div style="white-space:pre-wrap">${esc(message)}</div>` : ''}
      <p style="margin-top:24px;color:#666;font-size:13px;border-top:1px solid #eee;padding-top:12px">The document <b>${esc(safeName)}</b> is attached.<br>Sent from Made Well on behalf of ${esc(sender)}. Reply to this email to reach them directly.</p></div>`;

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.FROM_EMAIL || 'Made Well <onboarding@resend.dev>',
        to, cc: cc.length ? cc : undefined,
        reply_to: sender || undefined,
        subject, text, html,
        attachments: [{ filename: safeName, content: pdf.toString('base64') }],
      }),
    });
    if (!r.ok) {
      const detail = await r.text();
      console.error('[doc email] Resend', r.status, detail);
      return res.status(502).json({ ok: false, error: 'The email service rejected the message. Please check the address and try again.' });
    }
    res.json({ ok: true, sent_to: to });
  } catch (err) {
    console.error('[doc email]', err.message);
    res.status(500).json({ ok: false, error: 'Could not send the email.' });
  }
});

export { router as docsRouter };
