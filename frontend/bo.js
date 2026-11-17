const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
const API_BASE = isLocal ? 'http://localhost:4000' : 'https://madewell-backend.onrender.com';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const steps = [...document.querySelectorAll('.step')];
let cur = 0, lastRef = '', lastJson = '';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function validSAID(id) {
  if (!/^\d{13}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) { let d = +id[i]; if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; } sum += d; }
  return sum % 10 === 0;
}
// Date of birth and nationality come straight from a South African ID number, so we don't ask for them
function fromSAID(id) {
  const yy = +id.slice(0, 2), mm = +id.slice(2, 4), dd = +id.slice(4, 6), y = (yy > new Date().getFullYear() % 100 ? 1900 : 2000) + yy;
  return { dob: `${String(dd).padStart(2, '0')}/${String(mm).padStart(2, '0')}/${y}`, nat: id[10] === '0' ? 'South African' : 'South Africa (permanent resident)' };
}
const PROVS = ['Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo', 'Mpumalanga', 'Northern Cape', 'North West', 'Western Cape', 'Outside South Africa'];
const addrHTML = () => `<div class="addr">
  <label class="full">Street address<input class="a-street" autocomplete="address-line1" /></label>
  <label>Suburb<input class="a-suburb" autocomplete="address-line2" /></label>
  <label>City or town<input class="a-city" autocomplete="address-level2" /></label>
  <label>Province<select class="a-prov"><option value="">Select</option>${PROVS.map((p) => `<option>${p}</option>`).join('')}</select></label>
  <label>Postal code<input class="a-code" inputmode="numeric" maxlength="8" autocomplete="postal-code" /></label></div>`;
const addrVal = (el) => ['.a-street', '.a-suburb', '.a-city', '.a-prov', '.a-code'].map((c) => el.querySelector(c).value.trim()).filter(Boolean).join(', ');
const mark = (el, msg) => { el?.setAttribute('aria-invalid', true); el?.focus(); return msg; };

// ---------- owners ----------
function addOwner() {
  const n = document.querySelectorAll('.own').length + 1, f = document.createElement('fieldset');
  f.className = 'person own';
  f.innerHTML = `<legend>Owner ${n}</legend>
    <label>First name(s)<input class="o-first" autocomplete="off" /></label>
    <label>Surname<input class="o-sur" autocomplete="off" /></label>
    <label>ID type<select class="o-type"><option value="id">South African ID</option><option value="passport">Passport (not South African)</option></select></label>
    <label><span class="o-idl">ID number</span><input class="o-id" inputmode="numeric" autocomplete="off" /></label>
    <div class="o-pp" hidden><label>Nationality<input class="o-nat" /></label><label>Date of birth<input type="date" class="o-dob" /></label></div>
    <label>How much of the company do they own? (%)<input class="o-pct" type="number" min="1" max="100" step="0.01" inputmode="decimal" value="${n === 1 ? 100 : ''}" /></label>
    <label>Email<input class="o-email" type="email" autocomplete="off" /></label>
    <label>Mobile number<input class="o-phone" type="tel" autocomplete="off" /></label>
    <div class="addr-wrap"><span class="lbl">Home address</span>${addrHTML()}</div>
    <label>Certified copy of their ID<input type="file" class="o-file" accept="image/*,.pdf" /><small>A clear photo or PDF. We can’t file without it.</small></label>
    ${n > 1 ? '<button type="button" class="link rm">Remove this owner</button>' : ''}`;
  $('#owners').appendChild(f); total();
}
function renumber() { document.querySelectorAll('.own').forEach((e, i) => (e.querySelector('legend').textContent = `Owner ${i + 1}`)); }
function total() {
  const t = [...document.querySelectorAll('.o-pct')].reduce((a, e) => a + (parseFloat(e.value) || 0), 0), ok = Math.abs(t - 100) < 0.01, el = $('#total');
  el.textContent = ok ? 'Total: 100%. Perfect.' : `Total so far: ${Math.round(t * 100) / 100}%. It must add up to 100%.`; el.className = 'total' + (ok ? ' ok' : '');
}
const owners = () => [...document.querySelectorAll('.own')].map((e) => {
  const idType = e.querySelector('.o-type').value, id = e.querySelector('.o-id').value.replace(/\s/g, ''), info = idType === 'id' && validSAID(id) ? fromSAID(id) : {};
  const first = e.querySelector('.o-first').value.trim(), sur = e.querySelector('.o-sur').value.trim();
  return { name: `${first} ${sur}`.trim(), first, surname: sur, idType, id, nationality: idType === 'id' ? info.nat || '' : e.querySelector('.o-nat').value.trim(),
    dob: idType === 'id' ? info.dob || '' : dmy(e.querySelector('.o-dob').value),
    pct: parseFloat(e.querySelector('.o-pct').value), email: e.querySelector('.o-email').value.trim(), phone: e.querySelector('.o-phone').value.trim(), address: addrVal(e), file: e.querySelector('.o-file').files[0] || null };
});

// ---------- director who signs ----------
function renderAuth() {
  const os = owners(), keep = document.querySelector('input[name=auth]:checked')?.value;
  $('#auth-list').innerHTML = os.map((o, i) => `<label class="opt"><input type="radio" name="auth" value="${i}" ${keep == i || (keep === undefined && i === 0) ? 'checked' : ''} /><span><b>${esc(o.name || 'Owner ' + (i + 1))}</b><small>is a director of the company</small></span></label>`).join('')
    + `<label class="opt"><input type="radio" name="auth" value="other" ${keep === 'other' ? 'checked' : ''} /><span><b>Another director</b><small>Someone who isn’t listed as an owner</small></span></label>`;
  authChanged();
}
function authChanged() {
  const v = document.querySelector('input[name=auth]:checked')?.value; $('#other-dir').hidden = v !== 'other';
  const os = owners(); if (v !== 'other' && os[v]) $('#sig').value = os[v].name;
}
const director = () => {
  const v = document.querySelector('input[name=auth]:checked')?.value, o = owners()[v];
  return v === 'other' ? { name: $('#d-name').value.trim(), id: $('#d-id').value.replace(/\s/g, '') } : { name: o?.name || '', id: o?.id || '' };
};

// ---------- drawn signature ----------
const pad = $('#sigpad'), pctx = pad.getContext('2d'); let drawing = false, signed = false, last = null;
function initPad() {
  const r = pad.getBoundingClientRect(); if (!r.width || pad.dataset.ready) return;
  const k = window.devicePixelRatio || 1; pad.width = r.width * k; pad.height = r.height * k; pctx.scale(k, k);
  pctx.lineWidth = 2.6; pctx.lineCap = 'round'; pctx.lineJoin = 'round'; pctx.strokeStyle = '#111'; pad.dataset.ready = 1;
}
const padPt = (e) => { const r = pad.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
pad.addEventListener('pointerdown', (e) => { initPad(); drawing = true; last = padPt(e); pad.setPointerCapture(e.pointerId); pctx.beginPath(); pctx.moveTo(...last); pctx.lineTo(last[0] + 0.01, last[1]); pctx.stroke(); signed = true; $('#sig-hint').hidden = true; e.preventDefault(); });
pad.addEventListener('pointermove', (e) => { if (!drawing) return; const p = padPt(e); pctx.beginPath(); pctx.moveTo(...last); pctx.lineTo(...p); pctx.stroke(); last = p; });
['pointerup', 'pointercancel'].forEach((t) => pad.addEventListener(t, () => (drawing = false)));
$('#sig-clear').addEventListener('click', () => { pctx.clearRect(0, 0, pad.width, pad.height); signed = false; $('#sig-hint').hidden = false; });

// ---------- validation ----------
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
function problem(i) {
  document.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
  if (i === 0) {
    if ($('#c-name').value.trim().length < 2) return mark($('#c-name'), 'Enter the company name.');
    if (!$('#c-date').value) return mark($('#c-date'), 'Enter the date the company was registered. It is on your CIPC certificate.');
    if ($('#c-reg').value.trim().length < 5) return mark($('#c-reg'), 'Enter the company registration number. It looks like 2024/123456/07.');
    if (!isEmail($('#c-email').value.trim())) return mark($('#c-email'), 'Enter a valid email address.');
    if ($('#c-phone').value.replace(/\D/g, '').length < 9) return mark($('#c-phone'), 'Enter your mobile number.');
    for (const [box, w] of [[$('#c-addr'), 'company'], ...($('#same-post').checked ? [] : [[$('#c-post'), 'postal']])]) for (const [cl, nm] of [['.a-street', 'street address'], ['.a-suburb', 'suburb'], ['.a-city', 'city or town'], ['.a-prov', 'province']]) if (!box.querySelector(cl).value.trim()) return mark(box.querySelector(cl), `Enter the ${w} ${nm}.`);
  }
  if (i === 1) {
    for (const [k, e] of [...document.querySelectorAll('.own')].entries()) {
      const o = owners()[k], n = `Owner ${k + 1}`, g = (c) => e.querySelector(c);
      if (!o.first) return mark(g('.o-first'), `${n}: enter the first name(s).`);
      if (!o.surname) return mark(g('.o-sur'), `${n}: enter the surname.`);
      if (o.idType === 'id' && !validSAID(o.id)) return mark(g('.o-id'), `${n}: that doesn’t look like a valid 13-digit South African ID number. Check it for typing mistakes.`);
      if (o.idType === 'passport') { if (o.id.length < 5) return mark(g('.o-id'), `${n}: enter the passport number.`); if (!o.nationality) return mark(g('.o-nat'), `${n}: enter the nationality.`); if (!g('.o-dob').value) return mark(g('.o-dob'), `${n}: enter the date of birth.`); }
      if (!(o.pct > 0 && o.pct <= 100)) return mark(g('.o-pct'), `${n}: enter how much they own.`);
      if (!isEmail(o.email)) return mark(g('.o-email'), `${n}: enter a valid email address.`);
      if (o.phone.replace(/\D/g, '').length < 9) return mark(g('.o-phone'), `${n}: enter a mobile number.`);
      for (const [c, w] of [['.a-street', 'street address'], ['.a-suburb', 'suburb'], ['.a-city', 'city or town'], ['.a-prov', 'province']]) if (!g(c).value.trim()) return mark(g(c), `${n}: enter the ${w}.`);
      if (g('.o-file').files[0] && g('.o-file').files[0].size > 20e6) return mark(g('.o-file'), `${n}: that file is too big. Use a photo or a PDF under 3 MB.`);
    }
    if (Math.abs(owners().reduce((a, o) => a + o.pct, 0) - 100) > 0.01) return mark($('.o-pct'), 'The percentages must add up to 100%.');
  }
  if (i === 2) {
    const d = director();
    if (d.name.length < 2) return mark($('#d-name'), 'Enter the director’s full name.');
    if (document.querySelector('input[name=auth]:checked')?.value === 'other' && d.id.length < 5) return mark($('#d-id'), 'Enter the director’s ID number.');
    if (!signed) return mark(pad, 'Please sign in the box with your finger.');
    if ($('#sig').value.trim().length < 2) return mark($('#sig'), 'Type your full name under your signature.');
    if (!$('#confirm').checked) return mark($('#confirm'), 'Tick the box to confirm and sign the mandate.');
  }
  if (i === 3 && !$('#consent').checked) return mark($('#consent'), 'Please tick the box to continue.');
  return '';
}

// ---------- steps ----------
function show(i, push = true) {
  cur = i;
  if (push && i !== (history.state?.step ?? 0)) history.pushState({ step: i }, '', '#step-' + (i + 1));
  steps.forEach((s, k) => (s.hidden = k !== i));
  $('#progress').innerHTML = steps.map((s, k) => `<li class="${k < i ? 'done' : k === i ? 'now' : ''}">${s.dataset.title}</li>`).join('');
  $('#bo-error').hidden = true; $('#back').hidden = i === 0;
  $('#next').textContent = i === steps.length - 1 ? 'Pay R500 and send' : 'Next';
  if (i === 2) renderAuth();
  if (i === steps.length - 1) { summary(); if (window.fbq) fbq('track', 'InitiateCheckout', { value: 500, currency: 'ZAR' }); }
  window.scrollTo({ top: $('.reg').offsetTop, behavior: 'smooth' });
}
function summary() {
  const os = owners(), d = director();
  $('#summary').innerHTML = `<div><span>Company</span><b>${esc($('#c-name').value)}</b></div><div><span>Registration no.</span><b>${esc($('#c-reg').value)}</b></div>
    ${os.map((o) => `<div><span>${esc(o.name)}</span><b>${o.pct}%${o.file ? '' : ' · ID copy missing'}</b></div>`).join('')}
    <div><span>Director signing</span><b>${esc(d.name)}</b></div><div class="t"><span>Fixed fee</span><b>R500</b></div>`;
  $('#id-warn').hidden = os.every((o) => o.file);
}

// ---------- files ----------
function readFile(file) {
  return new Promise((resolve, reject) => {
    if (/^image\//.test(file.type)) { // shrink photos so uploads are fast on mobile data
      const img = new Image();
      img.onload = () => { const k = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = img.width * k; c.height = img.height * k; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); resolve({ mime: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.82).split(',')[1] }); };
      img.onerror = () => reject(new Error('We couldn’t read one of the photos.')); img.src = URL.createObjectURL(file);
    } else if (file.type === 'application/pdf') {
      if (file.size > 3e6) return reject(new Error('A PDF is too big. Please use a PDF under 3 MB, or a photo.'));
      const r = new FileReader(); r.onload = () => resolve({ mime: 'application/pdf', data: r.result.split(',')[1] }); r.readAsDataURL(file);
    } else reject(new Error('ID copies must be a photo or a PDF.'));
  });
}

// ---------- the three documents ----------
const fmtDate = (d) => d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
function startPdf(landscape, title, c) {
  const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4', orientation: landscape ? 'landscape' : 'portrait' }), W = doc.internal.pageSize.getWidth();
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.text(title, 40, 50);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.text(`${c.name}   |   Registration no. ${c.reg}`, 40, 68); doc.text(`Prepared on ${fmtDate(new Date())}`, 40, 82);
  doc.setDrawColor(150); doc.line(40, 92, W - 40, 92);
  return doc;
}
function table(doc, cols, rows, y0) {
  const H = doc.internal.pageSize.getHeight(), tw = cols.reduce((a, k) => a + k.w, 0);
  const head = (y) => { doc.setFillColor(228, 231, 238); doc.rect(40, y, tw, 22, 'F'); doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(20); let x = 40; cols.forEach((k) => { doc.text(k.h, x + 4, y + 14); x += k.w; }); doc.setFont('helvetica', 'normal'); return y + 22; };
  let y = head(y0);
  rows.forEach((r) => {
    const cells = r.map((t, i) => doc.splitTextToSize(String(t || '-'), cols[i].w - 8)), h = Math.max(...cells.map((l) => l.length)) * 11 + 10;
    if (y + h > H - 50) { doc.addPage(); y = head(50); }
    let x = 40; doc.setFontSize(8.5); cells.forEach((l, i) => { doc.text(l, x + 4, y + 13); x += cols[i].w; });
    doc.setDrawColor(200); doc.line(40, y + h, 40 + tw, y + h); y += h;
  });
  return y;
}
function finishPdf(doc, name) {
  const n = doc.getNumberOfPages(), H = doc.internal.pageSize.getHeight();
  for (let p = 1; p <= n; p++) { doc.setPage(p); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(120); doc.text(`Page ${p} of ${n}   |   Drafted from information supplied by the company   |   Made Well Media`, 40, H - 24); doc.setTextColor(0); }
  return { name, data: doc.output('datauristring').split('base64,')[1] };
}
const dmy = (iso) => { if (!iso) return ''; const [y, mo, d] = iso.split('-'); return `${d}/${mo}/${y}`; };
// Layout follows the preferred securities register template: title, company block, bordered table, Active, Signature, Date
function registerPdf(title, c, cols, rows, sigImg, ratio) {
  const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' }), W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text(title, W / 2, 54, { align: 'center' });
  const tw = doc.getTextWidth(title); doc.setLineWidth(0.8); doc.line(W / 2 - tw / 2, 58, W / 2 + tw / 2, 58);
  doc.setFontSize(10); let y = 90;
  [['Company Name:', c.name], ['Registration number:', c.reg], ['Street Address:', c.street], ['Postal Address:', c.postal]].forEach(([k, v]) => {
    doc.setFont('helvetica', 'bold'); doc.text(k, 40, y); const kw = doc.getTextWidth(k) + 8; doc.setFont('helvetica', 'normal');
    const l = doc.splitTextToSize(v || '', W - 80 - kw); doc.text(l, 40 + kw, y); y += Math.max(1, l.length) * 12 + 8;
  });
  y += 6; doc.setLineWidth(0.6); doc.setDrawColor(0);
  const head = (yy) => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
    const ls = cols.map((k) => doc.splitTextToSize(k.h, k.w - 8)), h = Math.max(...ls.map((l) => l.length)) * 11 + 8; let x = 40;
    ls.forEach((l, i) => { doc.rect(x, yy, cols[i].w, h); doc.text(l, x + 4, yy + 12); x += cols[i].w; });
    doc.setFont('helvetica', 'normal'); return yy + h;
  };
  y = head(y);
  rows.forEach((r) => {
    const cells = r.map((t, i) => doc.splitTextToSize(String(t || ''), cols[i].w - 8)), h = Math.max(...cells.map((l) => l.length)) * 11 + 8;
    if (y + h > H - 60) { doc.addPage(); y = head(50); }
    let x = 40; doc.setFontSize(8.5); cells.forEach((l, i) => { doc.rect(x, y, cols[i].w, h); doc.text(l, x + 4, y + 12); x += cols[i].w; }); y += h;
  });
  if (y + 150 > H - 40) { doc.addPage(); y = 50; }
  y += 26; doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.text('Active:', 40, y); doc.setFont('helvetica', 'normal'); doc.text('Yes', 82, y);
  y += 56; doc.setFont('helvetica', 'bold'); doc.text('Signature:', 40, y);
  const sh = 52; doc.addImage(sigImg, 'PNG', 104, y - 40, sh / ratio, sh); doc.setLineWidth(0.6); doc.line(104, y + 8, 290, y + 8);
  y += 34; doc.text('Date:', 40, y); doc.setFont('helvetica', 'normal'); doc.text(dmy(new Date().toISOString().slice(0, 10)), 70, y);
  return doc;
}
function makePdfs(c, os, d, sig, sigImg) {
  const ratio = pad.height / pad.width, issued = dmy(c.regDate), whole = os.every((o) => Number.isInteger(o.pct));
  const sec = os.map((o, i) => { const n = whole ? o.pct : Math.round(o.pct * 100); return [o.surname, o.first, o.id, String(i + 1).padStart(3, '0'), n, 'Ordinary Shares', issued, 'R' + n, o.email, o.phone]; }); // assumes R1 per share
  const a = registerPdf('Beneficial Ownership Register', c, [{ h: 'Surname', w: 70 }, { h: 'Full Names', w: 75 }, { h: 'ID Number / Unique identifier', w: 90 }, { h: 'Nationality', w: 60 }, { h: 'Date of Birth', w: 62 }, { h: 'Residential Address', w: 150 }, { h: 'Interest Held', w: 45 }, { h: 'Date Became Beneficial Owner', w: 62 }, { h: 'Email Address', w: 90 }, { h: 'Contact Number', w: 58 }],
    os.map((o) => [o.surname, o.first, o.id, o.nationality, o.dob, o.address, o.pct + '% shares', issued, o.email, o.phone]), sigImg, ratio);
  const b = registerPdf('Securities Register', c, [{ h: 'Securities holder Surname', w: 80 }, { h: 'Full Names', w: 85 }, { h: 'ID Number / Unique identifier', w: 100 }, { h: 'Certificate Nr.', w: 50 }, { h: 'Number Of Securities Issued', w: 62 }, { h: 'Class', w: 60 }, { h: 'Date Issued', w: 62 }, { h: 'Amount Paid', w: 50 }, { h: 'Email Address', w: 140 }, { h: 'Contact Number', w: 73 }], sec, sigImg, ratio);
  const m = startPdf(false, 'MANDATE AND AUTHORITY', c); let y = 118; const W = m.internal.pageSize.getWidth();
  const para = (t, bold) => { m.setFont('helvetica', bold ? 'bold' : 'normal'); m.setFontSize(10.5); const l = m.splitTextToSize(t, W - 80); m.text(l, 40, y); y += l.length * 15 + 10; };
  para('To file beneficial ownership information with the Companies and Intellectual Property Commission (CIPC)', true);
  para(`I, ${d.name} (${/^\d{13}$/.test(d.id) ? 'ID number' : 'passport number'} ${d.id}), a director of ${c.name} (registration number ${c.reg}), state the following:`);
  para('1. I authorise myself, in my capacity as a director of the company, to compile, sign and submit the company’s beneficial ownership register and securities register to the CIPC, and to receive and answer any correspondence about this filing.');
  para('2. The information in the registers was supplied by the company’s owners. To the best of my knowledge it is true, correct and complete.');
  para('3. I will make sure the CIPC is told about any change to this information within the time the law requires.');
  para('4. This mandate stays in force until I withdraw it in writing.');
  y += 10; const sh = 220 * (pad.height / pad.width); m.addImage(sigImg, 'PNG', 40, y, 220, sh); y += sh + 4; m.setDrawColor(60); m.line(40, y, 300, y); y += 16;
  m.setFont('helvetica', 'normal'); m.setFontSize(9.5); m.text(`Signed electronically by ${sig}, Director`, 40, y); y += 14; m.text(`Date: ${fmtDate(new Date())}`, 40, y);
  return [finishPdf(a, 'Beneficial Ownership Register.pdf'), finishPdf(b, 'Securities Register.pdf'), finishPdf(m, 'Mandate.pdf')];
}

// ---------- submit ----------
async function submit() {
  const err = $('#bo-error'), btn = $('#next'); btn.disabled = true; showLoader('Preparing your documents…');
  try {
    const os = owners(), d = director(), sig = $('#sig').value.trim();
    const c = { name: $('#c-name').value.trim(), reg: $('#c-reg').value.trim(), regDate: $('#c-date').value, street: addrVal($('#c-addr')), postal: $('#same-post').checked ? addrVal($('#c-addr')) : addrVal($('#c-post')), email: $('#c-email').value.trim(), phone: $('#c-phone').value.trim() };
    const ids = [];
    for (const [i, o] of os.entries()) if (o.file) ids.push({ owner: i, name: `ID copy - ${o.name}.${o.file.type === 'application/pdf' ? 'pdf' : 'jpg'}`, ...(await readFile(o.file)) });
    const pdfs = makePdfs(c, os, d, sig, pad.toDataURL('image/png'));
    const payload = { company: c, owners: os.map(({ file, ...o }) => o), auth: d, signature: { name: sig, confirmed: true }, pdfs, ids }, json = JSON.stringify(payload);
    const reuse = lastRef && json === lastJson;
    const res = await fetch(`${API_BASE}/api/bo${reuse ? '/pay' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: reuse ? JSON.stringify({ reference: lastRef }) : json });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || res.statusText);
    if (!reuse) { lastRef = out.reference; lastJson = json; }
    goToPayfast(out.payfast);
  } catch (ex) {
    hideLoader(); err.textContent = `${ex.message}. Nothing was lost on this page. Please try again.`; err.hidden = false; btn.disabled = false;
  }
}

$('#next').addEventListener('click', () => {
  const err = $('#bo-error'), msg = problem(cur);
  if (msg) { err.textContent = msg; err.hidden = false; return; }
  if (cur < steps.length - 1) return show(cur + 1);
  submit();
});
$('#back').addEventListener('click', () => (history.state?.step ? history.back() : show(cur - 1, false)));
$('#add-owner').addEventListener('click', addOwner);
$('#owners').addEventListener('click', (e) => { if (e.target.classList.contains('rm')) { e.target.closest('.own').remove(); renumber(); total(); } });
$('#owners').addEventListener('input', (e) => { if (e.target.classList.contains('o-pct')) total(); });
$('#owners').addEventListener('change', (e) => {
  if (e.target.classList.contains('o-type')) { const o = e.target.closest('.own'), pp = e.target.value === 'passport'; o.querySelector('.o-pp').hidden = !pp; o.querySelector('.o-idl').textContent = pp ? 'Passport number' : 'ID number'; }
});
$('#auth-list').addEventListener('change', authChanged);
window.addEventListener('popstate', (e) => show(e.state?.step ?? 0, false));
window.addEventListener('pageshow', (e) => { if (e.persisted) { hideLoader(); $('#next').disabled = false; } });
history.replaceState({ step: 0 }, '');
$('#c-addr').innerHTML = addrHTML(); $('#c-post').innerHTML = addrHTML();
$('#same-post').addEventListener('change', () => ($('#post-wrap').hidden = $('#same-post').checked));
addOwner(); show(0, false);
