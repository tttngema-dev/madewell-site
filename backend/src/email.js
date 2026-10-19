// Sends you a readable summary of each new company registration, using Resend (https://resend.com).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function buildEmail(ref, d) {
  const names = d.register_without_name
    ? ['Register with a number only (name to be chosen later)']
    : d.names.map((n, i) => `${i + 1}. ${n}`);

  // ---- plain-text version ----
  const text = [
    `NEW COMPANY REGISTRATION  ${ref}`, '',
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
    '1. Email the customer to confirm the fee and request certified ID copies of every director.',
    '2. Reserve the name(s) with CIPC, then file the company registration.',
    '3. Send the customer their registration documents.',
  ].join('\n');

  // ---- HTML version ----
  const row = (k, v) => `<tr><td style="padding:4px 12px 4px 0;color:#666;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:4px 0">${esc(v) || '-'}</td></tr>`;
  const h = (t) => `<h3 style="margin:24px 0 6px;font-size:15px;color:#b36b00;border-bottom:1px solid #eee;padding-bottom:4px">${t}</h3>`;
  const html = `
  <div style="font-family:Arial,sans-serif;font-size:14px;color:#1d1d1d;max-width:640px">
    <h2 style="margin:0 0 4px">New company registration</h2>
    <p style="margin:0;color:#666">Reference <b>${esc(ref)}</b></p>
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
    <ol style="margin:0;padding-left:20px"><li>Email the customer to confirm the fee and request certified ID copies of every director.</li><li>Reserve the name(s) with CIPC, then file the company registration.</li><li>Send the customer their registration documents.</li></ol>
  </div>`;
  return { text, html };
}

export async function sendRegistrationEmail(ref, d) {
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
      subject: `New company registration ${ref}: ${d.register_without_name ? 'number only' : d.names[0]}`,
      text, html,
    }),
  });
  if (!res.ok) { console.error('Resend error:', res.status, await res.text()); return false; }
  return true;
}
