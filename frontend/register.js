const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
const API_BASE = isLocal ? 'http://localhost:4000' : 'https://madewell-backend.onrender.com';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const steps = [...document.querySelectorAll('.step')];
let cur = 0;

// Valid 13-digit South African ID (Luhn check)
function validSAID(id) {
  if (!/^\d{13}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    let d = +id[i];
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

// ---------- progress ----------
const prog = $('#progress');
steps.forEach((s, i) => { const li = document.createElement('li'); li.textContent = s.dataset.title; prog.appendChild(li); });
function show(i) {
  cur = i;
  steps.forEach((s, k) => (s.hidden = k !== i));
  [...prog.children].forEach((li, k) => {
    li.className = k < i ? 'done' : k === i ? 'now' : '';
    k === i ? li.setAttribute('aria-current', 'step') : li.removeAttribute('aria-current');
  });
  $('#back').style.visibility = i ? 'visible' : 'hidden';
  $('#next').textContent = i === steps.length - 1 ? 'Submit my registration' : 'Next';
  $('#reg-error').hidden = true;
  if (i === 2) prefillShares();
  if (i === steps.length - 1) buildSummary();
  window.scrollTo({ top: $('.reg').offsetTop, behavior: 'smooth' });
}

// ---------- people blocks ----------
function field(label, cls, attrs = '') { return `<label>${label}<input class="${cls}" ${attrs} /></label>`; }

function addDirector() {
  const n = document.querySelectorAll('.dir').length + 1;
  const el = document.createElement('fieldset');
  el.className = 'person dir';
  el.innerHTML = `
    <legend>Director ${n}</legend>
    ${field('Full name', 'd-name', 'autocomplete="name"')}
    <label>ID type<select class="d-type"><option value="id">South African ID</option><option value="passport">Passport</option></select></label>
    ${field('ID or passport number', 'd-id')}
    ${field('Home address', 'd-addr', 'autocomplete="street-address"')}
    ${field('Email', 'd-email', 'type="email" autocomplete="email"')}
    ${field('Mobile number', 'd-phone', 'type="tel" autocomplete="tel"')}
    ${n > 1 ? '<button type="button" class="link rm">Remove this director</button>' : ''}`;
  el.querySelector('.rm')?.addEventListener('click', () => { el.remove(); renumber(); });
  $('#directors').appendChild(el);
}
function renumber() { document.querySelectorAll('.dir legend').forEach((l, i) => (l.textContent = `Director ${i + 1}`)); }

function addShare(p = {}) {
  const el = document.createElement('fieldset');
  el.className = 'person sh';
  el.innerHTML = `
    <legend>Owner</legend>
    ${field('Full name', 's-name')}
    ${field('ID or passport number', 's-id')}
    ${field('Share of the company (%)', 's-pct', 'type="number" min="1" max="100" step="0.01" inputmode="decimal"')}
    <button type="button" class="link rm">Remove this owner</button>`;
  el.querySelector('.s-name').value = p.name || '';
  el.querySelector('.s-id').value = p.id || '';
  el.querySelector('.s-pct').value = p.pct || '';
  el.querySelector('.rm').addEventListener('click', () => { el.remove(); total(); });
  el.addEventListener('input', total);
  $('#shareholders').appendChild(el);
  total();
}

function prefillShares() {
  if ($('#shareholders').children.length) return;
  const dirs = getDirectors();
  const each = dirs.length ? Math.round((10000 / dirs.length)) / 100 : '';
  dirs.forEach((d, i) => addShare({ name: d.name, id: d.id, pct: i === dirs.length - 1 ? +(100 - each * (dirs.length - 1)).toFixed(2) : each }));
}

function total() {
  const t = getShares().reduce((a, s) => a + (+s.pct || 0), 0);
  const ok = Math.abs(t - 100) < 0.01;
  const el = $('#share-total');
  el.textContent = `Total so far: ${+t.toFixed(2)}%${ok ? ' ✓' : ' (needs to be 100%)'}`;
  el.className = 'total' + (ok ? ' ok' : '');
}

const getDirectors = () => [...document.querySelectorAll('.dir')].map((e) => ({
  name: e.querySelector('.d-name').value.trim(), id_type: e.querySelector('.d-type').value,
  id: e.querySelector('.d-id').value.replace(/\s/g, ''), address: e.querySelector('.d-addr').value.trim(),
  email: e.querySelector('.d-email').value.trim(), phone: e.querySelector('.d-phone').value.trim(),
}));
const getShares = () => [...document.querySelectorAll('.sh')].map((e) => ({
  name: e.querySelector('.s-name').value.trim(), id: e.querySelector('.s-id').value.replace(/\s/g, ''),
  pct: +e.querySelector('.s-pct').value || 0,
}));

function data() {
  const regAddr = $('#reg-addr').value.trim();
  return {
    names: ['#n1', '#n2', '#n3', '#n4'].map((s) => $(s).value.trim()).filter(Boolean),
    register_without_name: $('#nonname').checked, activity: $('#activity').value.trim(),
    directors: getDirectors(), shareholders: getShares(),
    registered_address: regAddr, postal_address: $('#same-post').checked ? regAddr : $('#post-addr').value.trim(),
    company_email: $('#co-email').value.trim(), company_phone: $('#co-phone').value.trim(),
    financial_year_end: $('#fye').value, include_bo_filing: $('#include-bo').checked,
  };
}

// ---------- validation: returns a message, or '' if the step is fine ----------
function problem(i) {
  const d = data();
  const mark = (el, msg) => { el?.setAttribute('aria-invalid', true); el?.focus(); return msg; };
  document.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
  if (i === 0 && !d.register_without_name && !d.names.length) return mark($('#n1'), 'Enter at least one company name, or tick the box to register with a number only.');
  if (i === 1) {
    for (const [k, e] of [...document.querySelectorAll('.dir')].entries()) {
      const g = d.directors[k], n = k + 1;
      if (!g.name) return mark(e.querySelector('.d-name'), `Director ${n}: enter the full name.`);
      if (g.id_type === 'id' && !validSAID(g.id)) return mark(e.querySelector('.d-id'), `Director ${n}: that doesn’t look like a valid 13-digit South African ID number. Check it for typing mistakes.`);
      if (g.id_type === 'passport' && g.id.length < 5) return mark(e.querySelector('.d-id'), `Director ${n}: enter the passport number.`);
      if (!g.address) return mark(e.querySelector('.d-addr'), `Director ${n}: enter the home address.`);
      if (!/^\S+@\S+\.\S+$/.test(g.email)) return mark(e.querySelector('.d-email'), `Director ${n}: enter a valid email address.`);
      if (g.phone.replace(/\D/g, '').length < 9) return mark(e.querySelector('.d-phone'), `Director ${n}: enter a mobile number.`);
    }
  }
  if (i === 2) {
    if (!d.shareholders.length) return 'Add at least one owner.';
    for (const [k, e] of [...document.querySelectorAll('.sh')].entries()) {
      if (!d.shareholders[k].name) return mark(e.querySelector('.s-name'), 'Enter a name for every owner.');
      if (d.shareholders[k].id.length < 5) return mark(e.querySelector('.s-id'), `Enter the ID or passport number for ${d.shareholders[k].name}.`);
    }
    if (Math.abs(d.shareholders.reduce((a, s) => a + s.pct, 0) - 100) > 0.01) return mark($('.s-pct'), 'The ownership percentages must add up to exactly 100.');
  }
  if (i === 3) {
    if (!d.registered_address) return mark($('#reg-addr'), 'Enter the registered office address.');
    if (!$('#same-post').checked && !d.postal_address) return mark($('#post-addr'), 'Enter the postal address.');
    if (!$('#co-email').validity.valid || !d.company_email) return mark($('#co-email'), 'Enter a valid company email address.');
    if (d.company_phone.replace(/\D/g, '').length < 9) return mark($('#co-phone'), 'Enter a company phone number.');
  }
  if (i === 4 && !($('#auth').checked && $('#popia').checked)) return 'Please tick both boxes so we can go ahead.';
  return '';
}

function buildSummary() {
  const d = data();
  const names = d.register_without_name ? 'Registered with a number; name chosen later' : d.names.map((n, i) => `${i + 1}. ${esc(n)}`).join('<br>');
  $('#summary').innerHTML = `
    <div><h3>Company name</h3><p>${names}</p></div>
    <div><h3>Directors</h3><p>${d.directors.map((x) => esc(x.name)).join('<br>')}</p></div>
    <div><h3>Owners</h3><p>${d.shareholders.map((x) => `${esc(x.name)}: ${x.pct}%`).join('<br>')}</p></div>
    <div><h3>Registered office</h3><p>${esc(d.registered_address)}</p></div>
    <div><h3>Contact</h3><p>${esc(d.company_email)}<br>${esc(d.company_phone)}</p></div>
    <div><h3>Year-end</h3><p>${esc(d.financial_year_end)}</p></div>`;
}

// ---------- navigation and submit ----------
$('#next').addEventListener('click', async () => {
  const err = $('#reg-error'), msg = problem(cur);
  if (msg) { err.textContent = msg; err.hidden = false; return; }
  if (cur < steps.length - 1) return show(cur + 1);

  const btn = $('#next');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const res = await fetch(`${API_BASE}/api/registrations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data()),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || res.statusText);
    $('#reg-form').hidden = true; $('#progress').hidden = true;
    $('#done').hidden = false; $('#ref').textContent = out.reference;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (ex) {
    err.textContent = `We couldn’t send your details: ${ex.message}. Nothing was lost on this page. Please try again in a moment.`;
    err.hidden = false;
    btn.disabled = false; btn.textContent = 'Submit my registration';
  }
});
$('#back').addEventListener('click', () => show(cur - 1));
$('#add-director').addEventListener('click', addDirector);
$('#add-share').addEventListener('click', () => addShare());
$('#same-post').addEventListener('change', (e) => ($('#post-wrap').hidden = e.target.checked));
$('#reg-form').addEventListener('submit', (e) => e.preventDefault());

addDirector();
show(0);
