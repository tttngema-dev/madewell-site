/**
 * Authenticated account routes: company profile + saved tenders
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { supabase } from '../supabase.js';

const router = Router();

router.get('/account/profile', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('company_profiles')
      .select('*')
      .eq('id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    res.json({ ok: true, profile: data || null, email: req.user.email });
  } catch (err) {
    console.error('[profile get]', err.message);
    res.status(500).json({ ok: false, error: 'Could not load profile' });
  }
});

router.put('/account/profile', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const row = {
      id: req.user.id,
      registered_name: body.registered_name ?? null,
      cipc_number: body.cipc_number ?? null,
      trading_name: body.trading_name ?? null,
      address_line1: body.address_line1 ?? null,
      address_line2: body.address_line2 ?? null,
      city: body.city ?? null,
      province: body.province ?? null,
      postal_code: body.postal_code ?? null,
      contact_email: body.contact_email ?? req.user.email,
      contact_phone: body.contact_phone ?? null,
      directors: body.directors ?? [],
      tax_number: body.tax_number ?? null,
      vat_number: body.vat_number ?? null,
      banking: body.banking ?? {},
      industries: body.industries ?? [],
      bbbee_level: body.bbbee_level ?? null,
      cidb_grade: body.cidb_grade ?? null,
      cidb_number: body.cidb_number ?? null,
      updated_at: new Date().toISOString(),
    };
    // newer columns: only written when the form sent them, so older forms never wipe them
    const extra = {};
    if (body.csd_number !== undefined) extra.csd_number = String(body.csd_number || '').trim().slice(0, 40) || null;
    let { data, error } = await supabase.from('company_profiles').upsert({ ...row, ...extra }, { onConflict: 'id' }).select().single();
    let needsSql = false;
    if (error && /csd_number|quick_fills/i.test(error.message || '')) { // SQL not run yet: save everything else rather than fail
      needsSql = true;
      ({ data, error } = await supabase.from('company_profiles').upsert(row, { onConflict: 'id' }).select().single());
    }
    if (error) throw error;
    res.json({ ok: true, profile: data, needs_sql: needsSql });
  } catch (err) {
    console.error('[profile put]', err.message);
    res.status(500).json({ ok: false, error: err.message || 'Could not save profile' });
  }
});

// Quick-fill items people add themselves (a label and a value), kept for good
router.put('/account/quickfills', requireAuth, async (req, res) => {
  try {
    const items = (Array.isArray(req.body && req.body.items) ? req.body.items : []).slice(0, 40)
      .map((x) => ({ id: String((x && x.id) || Math.random().toString(36).slice(2, 10)).slice(0, 20), label: String((x && x.label) || '').trim().slice(0, 40), value: String((x && x.value) || '').trim().slice(0, 400) }))
      .filter((x) => x.label && x.value);
    const { error } = await supabase.from('company_profiles').upsert({ id: req.user.id, quick_fills: items, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    if (error) {
      if (/quick_fills/i.test(error.message || '')) return res.status(500).json({ ok: false, error: 'Quick-fill needs one more setup step. Run backend/sql/run_this_once.sql in Supabase.' });
      throw error;
    }
    res.json({ ok: true, items });
  } catch (err) {
    console.error('[quickfills put]', err.message);
    res.status(500).json({ ok: false, error: 'Could not save that. Please try again.' });
  }
});

router.get('/account/saved', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('saved_tenders')
      .select('*')
      .eq('user_id', req.user.id)
      .order('closing_date', { ascending: true, nullsFirst: false });
    if (error) throw error;
    res.json({ ok: true, items: data || [] });
  } catch (err) {
    console.error('[saved get]', err.message);
    res.status(500).json({ ok: false, error: 'Could not load saved tenders' });
  }
});

router.post('/account/saved', requireAuth, async (req, res) => {
  try {
    const { ocid, title, buyer, closing_date, status, documents } = req.body || {};
    if (!ocid) return res.status(400).json({ ok: false, error: 'ocid required' });
    const row = {
      user_id: req.user.id,
      ocid,
      title: title || null,
      buyer: buyer || null,
      closing_date: closing_date || null,
      status: status || 'watching',
    };
    // Keep the tender's document list so the dashboard can open them later.
    const docs = Array.isArray(documents)
      ? documents.slice(0, 100).filter((d) => d && d.url).map((d) => ({
          id: d.id ?? null, title: String(d.title || 'Document').slice(0, 300),
          url: String(d.url), format: d.format || '', datePublished: d.datePublished || null,
        }))
      : null;
    let result = await supabase
      .from('saved_tenders')
      .upsert(docs ? { ...row, documents: docs } : row, { onConflict: 'user_id,ocid' })
      .select()
      .single();
    // If the "documents" column hasn't been added yet (SQL not run), still save the tender.
    if (result.error && docs && /documents/i.test(result.error.message || '')) {
      result = await supabase.from('saved_tenders').upsert(row, { onConflict: 'user_id,ocid' }).select().single();
    }
    if (result.error) throw result.error;
    res.json({ ok: true, item: result.data });
  } catch (err) {
    console.error('[saved post]', err.message);
    res.status(500).json({ ok: false, error: err.message || 'Could not save tender' });
  }
});

router.patch('/account/saved/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const updates = {};
    if (req.body.status != null) updates.status = req.body.status;
    if (req.body.notes != null) updates.notes = req.body.notes;
    const { data, error } = await supabase
      .from('saved_tenders')
      .update(updates)
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, item: data });
  } catch (err) {
    console.error('[saved patch]', err.message);
    res.status(500).json({ ok: false, error: 'Could not update' });
  }
});

router.delete('/account/saved/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('saved_tenders')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[saved delete]', err.message);
    res.status(500).json({ ok: false, error: 'Could not remove' });
  }
});

router.get('/account/saved/ocid/:ocid', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('saved_tenders')
      .select('id, status')
      .eq('user_id', req.user.id)
      .eq('ocid', req.params.ocid)
      .maybeSingle();
    if (error) throw error;
    res.json({ ok: true, saved: !!data, item: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Lookup failed' });
  }
});

export { router as accountRouter };
