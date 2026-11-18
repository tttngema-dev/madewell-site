/**
 * Company documents (CIPC, CSD, B-BBEE, CIDB, tax clearance …) and the user's saved signature.
 * Files live in the private Supabase Storage bucket "company-docs"; only this backend touches it.
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '../middleware/auth.js';
import { supabase } from '../supabase.js';

const router = Router();
const BUCKET = 'company-docs';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DOCS = 40;
const TYPES = new Set(['cipc', 'csd', 'bbbee', 'cidb', 'tax', 'vat', 'coida', 'bank', 'directors_id', 'other']);
const UNIQUE_TYPES = new Set([...TYPES].filter((t) => t !== 'other')); // uploading again replaces the old one

function sniff(buf) {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  return null;
}
const cleanName = (s) => String(s || 'document').replace(/[^\w.\- ]+/g, '').trim().slice(0, 120) || 'document';
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const PUBLIC_COLS = 'id, doc_type, label, file_name, mime_type, size_bytes, expires_on, uploaded_at';

router.get('/account/company-docs', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('company_documents').select(PUBLIC_COLS)
      .eq('user_id', req.user.id).order('uploaded_at', { ascending: true });
    if (error) throw error;
    res.json({ ok: true, items: data || [] });
  } catch (err) {
    console.error('[company-docs get]', err.message);
    res.status(500).json({ ok: false, error: 'Could not load your documents. Run backend/sql/company_docs.sql in Supabase.' });
  }
});

router.post('/account/company-docs', requireAuth, async (req, res) => {
  let uploadedPath = null;
  try {
    const b = req.body || {};
    const docType = String(b.doc_type || '');
    if (!TYPES.has(docType)) return res.status(400).json({ ok: false, error: 'Unknown document type.' });
    const buf = Buffer.from(String(b.file_base64 || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buf.length) return res.status(400).json({ ok: false, error: 'No file received.' });
    if (buf.length > MAX_FILE_BYTES) return res.status(413).json({ ok: false, error: 'That file is over 8 MB. Please upload a smaller scan.' });
    const kind = sniff(buf);
    if (!kind) return res.status(400).json({ ok: false, error: 'Only PDF, JPG or PNG files can be uploaded.' });
    if (b.expires_on && !isDate(b.expires_on)) return res.status(400).json({ ok: false, error: 'Expiry date is not valid.' });

    const { data: existing, error: e0 } = await supabase.from('company_documents').select('id, doc_type, storage_path').eq('user_id', req.user.id);
    if (e0) throw e0;
    const old = UNIQUE_TYPES.has(docType) ? (existing || []).filter((d) => d.doc_type === docType) : [];
    if ((existing || []).length - old.length >= MAX_DOCS) return res.status(400).json({ ok: false, error: `You can keep up to ${MAX_DOCS} documents.` });

    const id = randomUUID();
    uploadedPath = `${req.user.id}/${id}.${kind.ext}`;
    const up = await supabase.storage.from(BUCKET).upload(uploadedPath, buf, { contentType: kind.mime, upsert: false });
    if (up.error) throw up.error;

    const row = {
      id, user_id: req.user.id, doc_type: docType,
      label: b.label ? String(b.label).trim().slice(0, 80) : null,
      file_name: cleanName(b.file_name), mime_type: kind.mime, size_bytes: buf.length,
      storage_path: uploadedPath, expires_on: b.expires_on || null,
    };
    const { data, error } = await supabase.from('company_documents').insert(row).select(PUBLIC_COLS).single();
    if (error) throw error;
    uploadedPath = null;

    if (old.length) { // replaced: remove the previous file(s)
      await supabase.from('company_documents').delete().in('id', old.map((d) => d.id)).eq('user_id', req.user.id);
      await supabase.storage.from(BUCKET).remove(old.map((d) => d.storage_path));
    }
    res.json({ ok: true, item: data });
  } catch (err) {
    console.error('[company-docs post]', err.message);
    if (uploadedPath) await supabase.storage.from(BUCKET).remove([uploadedPath]).catch(() => {});
    res.status(500).json({ ok: false, error: 'Could not save the document. Run backend/sql/company_docs.sql in Supabase.' });
  }
});

router.patch('/account/company-docs/:id', requireAuth, async (req, res) => {
  try {
    const u = {};
    if ('expires_on' in (req.body || {})) {
      if (req.body.expires_on && !isDate(req.body.expires_on)) return res.status(400).json({ ok: false, error: 'Expiry date is not valid.' });
      u.expires_on = req.body.expires_on || null;
    }
    if (typeof req.body?.label === 'string') u.label = req.body.label.trim().slice(0, 80) || null;
    if (!Object.keys(u).length) return res.status(400).json({ ok: false, error: 'Nothing to update.' });
    const { data, error } = await supabase.from('company_documents').update(u)
      .eq('id', req.params.id).eq('user_id', req.user.id).select(PUBLIC_COLS).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, item: data });
  } catch (err) {
    console.error('[company-docs patch]', err.message);
    res.status(500).json({ ok: false, error: 'Could not update.' });
  }
});

router.get('/account/company-docs/:id/file', requireAuth, async (req, res) => {
  try {
    const { data: row, error } = await supabase.from('company_documents').select('storage_path, mime_type, file_name')
      .eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
    const dl = await supabase.storage.from(BUCKET).download(row.storage_path);
    if (dl.error) throw dl.error;
    const buf = Buffer.from(await dl.data.arrayBuffer());
    res.set({
      'Content-Type': row.mime_type || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${cleanName(row.file_name).replace(/"/g, '')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.send(buf);
  } catch (err) {
    console.error('[company-docs file]', err.message);
    res.status(500).json({ ok: false, error: 'Could not open the document.' });
  }
});

router.delete('/account/company-docs/:id', requireAuth, async (req, res) => {
  try {
    const { data: row } = await supabase.from('company_documents').select('storage_path')
      .eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
    if (!row) return res.json({ ok: true });
    const { error } = await supabase.from('company_documents').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    if (error) throw error;
    await supabase.storage.from(BUCKET).remove([row.storage_path]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[company-docs delete]', err.message);
    res.status(500).json({ ok: false, error: 'Could not delete.' });
  }
});

// ---------------------------------------------------------------------------
// Saved signature
// ---------------------------------------------------------------------------
const MAX_SIG_CHARS = 300 * 1024;
router.get('/account/signature', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('user_signatures').select('png, width, height, updated_at').eq('user_id', req.user.id).maybeSingle();
    if (error) throw error;
    res.json({ ok: true, signature: data || null });
  } catch (err) {
    console.error('[signature get]', err.message);
    res.status(500).json({ ok: false, error: 'Could not load your signature. Run backend/sql/company_docs.sql in Supabase.' });
  }
});

router.put('/account/signature', requireAuth, async (req, res) => {
  try {
    const { png, width, height } = req.body || {};
    if (typeof png !== 'string' || !png.startsWith('data:image/png;base64,') || png.length > MAX_SIG_CHARS) {
      return res.status(400).json({ ok: false, error: 'That signature could not be saved.' });
    }
    const { error } = await supabase.from('user_signatures').upsert({
      user_id: req.user.id, png, width: Math.round(+width) || null, height: Math.round(+height) || null, updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[signature put]', err.message);
    res.status(500).json({ ok: false, error: 'Could not save your signature. Run backend/sql/company_docs.sql in Supabase.' });
  }
});

router.delete('/account/signature', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('user_signatures').delete().eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Could not remove your signature.' });
  }
});

export { router as companyDocsRouter };
