import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { supabase } from '../supabase.js';

export const registrationsRouter = Router();

const validSAID = (id) => {
  if (!/^\d{13}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    let d = +id[i];
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);

// POST /api/registrations — save a company registration request
registrationsRouter.post('/registrations', async (req, res) => {
  const b = req.body ?? {};
  const names = (Array.isArray(b.names) ? b.names : []).map((n) => str(n, 120)).filter(Boolean).slice(0, 4);
  const directors = (Array.isArray(b.directors) ? b.directors : []).slice(0, 10).map((d) => ({
    name: str(d.name), id_type: d.id_type === 'passport' ? 'passport' : 'id', id: str(d.id, 30).replace(/\s/g, ''),
    address: str(d.address, 400), email: str(d.email, 200), phone: str(d.phone, 30),
  }));
  const shareholders = (Array.isArray(b.shareholders) ? b.shareholders : []).slice(0, 20).map((s) => ({
    name: str(s.name), id: str(s.id, 30).replace(/\s/g, ''), pct: Number(s.pct) || 0,
  }));

  if (!names.length && !b.register_without_name) return res.status(400).json({ error: 'A company name or number-only registration is required' });
  if (!directors.length) return res.status(400).json({ error: 'At least one director is required' });
  for (const d of directors) {
    if (!d.name || !/^\S+@\S+\.\S+$/.test(d.email)) return res.status(400).json({ error: 'Each director needs a name and a valid email' });
    if (d.id_type === 'id' && !validSAID(d.id)) return res.status(400).json({ error: `Invalid ID number for ${d.name}` });
  }
  const total = shareholders.reduce((a, s) => a + s.pct, 0);
  if (!shareholders.length || Math.abs(total - 100) > 0.01) return res.status(400).json({ error: 'Shareholder percentages must add up to 100' });

  const reference = 'MW-' + randomBytes(3).toString('hex').toUpperCase();
  const payload = {
    names, register_without_name: !!b.register_without_name, activity: str(b.activity),
    directors, shareholders,
    registered_address: str(b.registered_address, 400), postal_address: str(b.postal_address, 400),
    company_email: str(b.company_email, 200), company_phone: str(b.company_phone, 30),
    financial_year_end: str(b.financial_year_end, 20), include_bo_filing: !!b.include_bo_filing,
  };

  const { error } = await supabase.from('company_registrations').insert({
    reference, status: 'received', contact_email: directors[0].email, data: payload,
  });
  if (error) { console.error('registration insert failed:', error.message); return res.status(500).json({ error: 'Could not save your registration' }); }

  // TODO: send confirmation email (Resend/SendGrid) to contact_email and to you.
  res.status(201).json({ reference });
});
