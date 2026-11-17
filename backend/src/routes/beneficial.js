import { Router } from 'express';
import crypto from 'node:crypto';
import { supabase } from '../supabase.js';
import { buildPayment, FEE_BO } from '../payfast.js';

export const beneficialRouter = Router();

const validSAID = (id) => {
  if (!/^\d{13}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) { let d = +id[i]; if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; } sum += d; }
  return sum % 10 === 0;
};
const str = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const fileName = (v) => str(v, 80).replace(/[^\w .()\-]/g, '_') || 'file';
const OK_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const B64 = /^[A-Za-z0-9+/=]+$/;

const hits = new Map(); // simple abuse limit: 12 submissions per IP per hour
const limited = (ip) => { const n = Date.now(), h = (hits.get(ip) || []).filter((t) => n - t < 36e5); h.push(n); hits.set(ip, h); return h.length > 12; };

function validate(b) {
  const c = { name: str(b.company?.name), reg: str(b.company?.reg, 40), regDate: str(b.company?.regDate, 20), street: str(b.company?.street, 300), postal: str(b.company?.postal, 300), email: str(b.company?.email).toLowerCase(), phone: str(b.company?.phone, 30) };
  if (c.name.length < 2) return { error: 'Enter the company name.' };
  if (c.reg.length < 5) return { error: 'Enter the company registration number.' };
  if (c.street.length < 8) return { error: 'Enter the company address.' };
  if (!isEmail(c.email)) return { error: 'Enter a valid email address.' };
  if (c.phone.replace(/\D/g, '').length < 9) return { error: 'Enter a valid mobile number.' };
  if (!Array.isArray(b.owners) || !b.owners.length || b.owners.length > 15) return { error: 'Add at least one owner.' };
  const owners = [];
  for (const [i, o] of b.owners.entries()) {
    const x = { name: str(o.name), idType: o.idType === 'passport' ? 'passport' : 'id', id: str(o.id, 30), nationality: str(o.nationality, 60), dob: str(o.dob, 40), pct: Math.round(parseFloat(o.pct) * 100) / 100, email: str(o.email).toLowerCase(), phone: str(o.phone, 30), address: str(o.address, 300) };
    const n = `Owner ${i + 1}`;
    if (x.name.length < 2) return { error: `${n}: enter the full name.` };
    if (x.idType === 'id' && !validSAID(x.id)) return { error: `${n}: that is not a valid South African ID number.` };
    if (x.idType === 'passport' && (x.id.length < 5 || !x.nationality || !x.dob)) return { error: `${n}: enter the passport number, nationality and date of birth.` };
    if (!(x.pct > 0 && x.pct <= 100)) return { error: `${n}: enter the percentage they own.` };
    if (!isEmail(x.email)) return { error: `${n}: enter a valid email address.` };
    if (x.phone.replace(/\D/g, '').length < 9) return { error: `${n}: enter a valid mobile number.` };
    if (x.address.length < 8) return { error: `${n}: enter the address.` };
    owners.push(x);
  }
  if (Math.abs(owners.reduce((a, o) => a + o.pct, 0) - 100) > 0.01) return { error: 'The ownership percentages must add up to exactly 100%.' };
  const auth = { name: str(b.auth?.name), id: str(b.auth?.id, 30) };
  if (auth.name.length < 2 || auth.id.length < 5) return { error: 'Enter the director who will sign.' };
  const signature = { name: str(b.signature?.name) };
  if (signature.name.length < 2 || b.signature?.confirmed !== true) return { error: 'Type your name and tick the box to sign the mandate.' };
  const files = [];
  const add = (kind, f, owner) => {
    if (!f || !OK_MIME.has(f.mime) || typeof f.data !== 'string' || !B64.test(f.data) || f.data.length > (kind === 'pdf' ? 4e6 : 8e6)) return false;
    files.push({ kind, owner: kind === 'id' ? owner : null, name: fileName(f.name), mime: f.mime, data: f.data }); return true;
  };
  const pdfs = Array.isArray(b.pdfs) ? b.pdfs.slice(0, 5) : [];
  if (pdfs.length < 3 || !pdfs.every((f) => add('pdf', { ...f, mime: 'application/pdf' }))) return { error: 'Your documents could not be prepared. Please try again.' };
  for (const f of (Array.isArray(b.ids) ? b.ids.slice(0, 15) : [])) {
    const k = parseInt(f.owner, 10);
    if (!(k >= 0 && k < owners.length) || !add('id', f, k)) return { error: 'One of the ID copies is too large or not a photo or PDF.' };
  }
  return { data: { company: c, owners, auth, signature }, files };
}

beneficialRouter.post('/', async (req, res) => {
  try {
    if (limited(req.ip)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    const v = validate(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const reference = 'BO-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const { error } = await supabase.from('bo_filings').insert({ reference, status: 'awaiting_payment', contact_email: v.data.company.email, data: v.data });
    if (error) { console.error('BO save error:', error.message); return res.status(500).json({ error: 'We could not save your details. Please try again.' }); }
    const { error: fe } = await supabase.from('bo_files').insert(v.files.map((f) => ({ reference, ...f })));
    if (fe) { console.error('BO files save error:', fe.message); return res.status(500).json({ error: 'We could not save your files. Please try again.' }); }
    res.json({ reference, payfast: pay(reference, v.data) });
  } catch (e) { console.error('BO error:', e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// Used when someone comes back from PayFast and pays again without changing anything
beneficialRouter.post('/pay', async (req, res) => {
  const { data: f } = await supabase.from('bo_filings').select('reference,data,status').eq('reference', String(req.body?.reference || '')).maybeSingle();
  if (!f || f.status !== 'awaiting_payment') return res.status(404).json({ error: 'We could not find an unpaid filing with that reference.' });
  res.json({ reference: f.reference, payfast: pay(f.reference, f.data) });
});

const pay = (reference, d) => buildPayment({ reference, contact_email: d.company.email }, { amount: FEE_BO, item: 'Beneficial ownership filing', desc: `Made Well beneficial ownership ${reference}`, ok: 'bo-success.html', cancel: 'bo-cancelled.html', payer: d.auth.name });
