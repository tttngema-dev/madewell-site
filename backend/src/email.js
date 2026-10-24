// Sends you a readable summary of each new company registration, using Resend (https://resend.com).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function buildEmail(ref, d) {
  const names = d.register_without_name
    ? ['Register with a number only (name to be chosen later)']
    : d.names.map((n, i) => `${i + 1}. ${n}`);

  // ---- plain-text version ----
  const text = [
    `NEW COMPANY REGISTRATION  ${ref}`, 'PAYMENT: R780 received via PayFast', '',
    'COMPANY NAME (in order of preference)', ...names, '',
    `What it does: ${d.activity || '-'}`, '',
    'DIRECTORS',
    ...d.directors.flatMap((p, i) => [
      `Director ${i + 1}: ${p.name}`,
      `  ${p.id_type === 'passport' ? 'Passport' : 'ID number'}: ${p.id}`,
      `  Home address: ${p.address}`, `  Email: ${p.email}`, `  Mobile: ${p.phone}`, '',
    ]),
    'SHAREHOLDERS',
    ...d.shareholders.map((s) => `${s.name} (${s.id}): ${s.pct}%`), '',
    `Registered office: ${d.registered_address}`,
    `Postal address: ${d.postal_address}`,
    `Company email: ${d.company_email}`, `Company phone: ${d.company_phone}`,
    `Financial year-end: ${d.financial_year_end}`,
    `Beneficial Ownership filing: ${d.include_bo_filing ? 'YES, include it' : 'No'}`, '',
    'NEXT STEPS',
    '1. Email the customer and request certified ID copies of every director.',
    '2. Reserve the name(s) with CIPC, then file the company registration.',
    '3. Send the customer their registration documents.',
  ].join('\n');

  // ---- HTML version ----
  const row = (k, v) => `<tr><td style="padding:4px 12px 4px 0;color:#666;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:4px 0">${esc(v) || '-'}</td></tr>`;
  const h = (t) => `<h3 style="margin:24px 0 6px;font-size:15px;color:#b36b00;border-bottom:1px solid #eee;padding-bottom:4px">${t}</h3>`;
  const html = `
  <div style="font-family:Arial,sans-serif;font-size:14px;color:#1d1d1d;max-width:640px">
    <h2 style="margin:0 0 4px">New company registration</h2>
    <p style="margin:0;color:#666">Reference <b>${esc(ref)}</b> · <b style="color:#1a7f4b">R780 paid via PayFast</b></p>
    ${h('Company name (in order of preference)')}
    <p style="margin:0">${names.map(esc).join('<br>')}</p>
    <p style="margin:8px 0 0"><span style="color:#666">What it does:</span> ${esc(d.activity) || '-'}</p>
    ${h('Directors')}
    ${d.directors.map((p, i) => `<table style="margin-bottom:10px"><tr><td colspan="2"><b>Director ${i + 1}: ${esc(p.name)}</b></td></tr>
      ${row(p.id_type === 'passport' ? 'Passport' : 'ID number', p.id)}${row('Home address', p.address)}${row('Email', p.email)}${row('Mobile', p.phone)}</table>`).join('')}
    ${h('Shareholders')}
    <table>${d.shareholders.map((s) => row(`${s.name} (${s.id})`, `${s.pct}%`)).join('')}</table>
    ${h('Company details')}
    <table>${row('Registered office', d.registered_address)}${row('Postal address', d.postal_address)}${row('Company email', d.company_email)}${row('Company phone', d.company_phone)}${row('Financial year-end', d.financial_year_end)}${row('Beneficial Ownership filing', d.include_bo_filing ? 'YES, include it' : 'No')}</table>
    ${h('Next steps')}
    <ol style="margin:0;padding-left:20px"><li>Email the customer and request certified ID copies of every director.</li><li>Reserve the name(s) with CIPC, then file the company registration.</li><li>Send the customer their registration documents.</li></ol>
  </div>`;
  return { text, html };
}

export async function sendRegistrationEmail(ref, d, paid = false) {
  const key = process.env.RESEND_API_KEY, to = process.env.NOTIFY_EMAIL;
  if (!key || !to) { console.warn('Email not sent: RESEND_API_KEY or NOTIFY_EMAIL is not set'); return false; }
  const { text, html } = buildEmail(ref, d);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL || 'Made Well <onboarding@resend.dev>',
      to: [to],
      reply_to: d.directors[0]?.email, // hitting Reply goes straight to the customer
      subject: `${paid ? 'PAID R780 · ' : ''}New company registration ${ref}: ${d.register_without_name ? 'number only' : d.names[0]}`,
      text, html,
    }),
  });
  if (!res.ok) { console.error('Resend error:', res.status, await res.text()); return false; }
  return true;
}

// Receipt sent to the customer (first director's email) once PayFast confirms payment.
export async function sendReceiptEmail(reg, pfPaymentId) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const d = reg.data, to = reg.contact_email;
  const company = d.register_without_name ? 'Your new company (name to be chosen)' : d.names[0];
  const name = (d.directors[0]?.name || '').split(' ')[0] || 'there';
  const date = new Date().toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' });
  const lines = [['Reference', reg.reference], ['Date', date], ['Description', 'Company registration (Pty) Ltd'], ['Company', company], ['PayFast payment ID', pfPaymentId || '-'], ['Amount paid', 'R780.00']];

  const text = [`Hi ${name},`, '', 'Thank you. We’ve received your payment.', '',
    ...lines.map(([k, v]) => `${k}: ${v}`), '',
    'WHAT HAPPENS NEXT',
    '1. We’ll email you to collect certified copies of each director’s ID.',
    '2. Once we have them, we submit your registration to CIPC.',
    '3. We email you your registration documents.', '',
    'Please keep this email as your receipt. Reply to this email if you have any questions.', '', 'Made Well'].join('\n');

  const html = `
  <div style="font-family:Arial,sans-serif;font-size:15px;color:#1d1d1d;max-width:560px;margin:auto">
    <h2 style="margin:0 0 4px">Payment received</h2>
    <p style="margin:0 0 20px;color:#666">Hi ${esc(name)}, thank you. Your company registration is under way.</p>
    <table style="width:100%;border-collapse:collapse">
      ${lines.map(([k, v]) => `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666">${esc(k)}</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right"><b>${esc(v)}</b></td></tr>`).join('')}
    </table>
    <h3 style="margin:28px 0 8px;color:#b36b00">What happens next</h3>
    <ol style="margin:0;padding-left:20px;line-height:1.7">
      <li>We’ll email you to collect certified copies of each director’s ID.</li>
      <li>Once we have them, we submit your registration to CIPC.</li>
      <li>We email you your registration documents.</li>
    </ol>
    <p style="margin-top:28px;color:#666">Keep this email as your receipt. Reply to it if you have any questions.<br>Made Well</p>
  </div>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL || 'Made Well <onboarding@resend.dev>',
      to: [to], reply_to: process.env.NOTIFY_EMAIL || undefined,
      subject: `Your Made Well receipt: ${reg.reference}`, text, html,
    }),
  });
  if (!res.ok) { console.error('Receipt email error:', res.status, await res.text()); return false; }
  return true;
}
