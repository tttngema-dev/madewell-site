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

const PROVS = ['Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo', 'Mpumalanga', 'Northern Cape', 'North West', 'Western Cape'];
const addrHTML = () => `<div class="addr">
  <label class="full">Street address<input class="a-street" autocomplete="address-line1" placeholder="e.g. 12 Smith Street" /></label>
  <label>Suburb<input class="a-suburb" autocomplete="address-line2" /></label>
  <label>City or town<input class="a-city" autocomplete="address-level2" /></label>
  <label>Province<select class="a-prov"><option value="">Select province</option>${PROVS.map((p) => `<option>${p}</option>`).join('')}</select></label>
  <label>Postal code<input class="a-code" inputmode="numeric" maxlength="4" autocomplete="postal-code" placeholder="e.g. 4001" /></label>
</div>`;
const addrVal = (el) => ['.a-street', '.a-suburb', '.a-city', '.a-prov', '.a-code'].map((c) => el.querySelector(c).value.trim()).filter(Boolean).join(', ');
const mark = (el, msg) => { el?.setAttribute('aria-invalid', true); el?.focus(); return msg; };
function addrCheck(el, who) {
  for (const [c, n] of [['.a-street', 'street address'], ['.a-suburb', 'suburb'], ['.a-city', 'city or town'], ['.a-prov', 'province']])
    if (!el.querySelector(c).value.trim()) return mark(el.querySelector(c), `${who}: enter the ${n}.`);
  if (!/^\d{4}$/.test(el.querySelector('.a-code').value.trim())) return mark(el.querySelector('.a-code'), `${who}: enter the 4-digit postal code.`);
  return '';
}
const nameMode = () => document.querySelector('input[name=namemode]:checked').value;

// ---------- progress ----------
const prog = $('#progress');
steps.forEach((s, i) => { const li = document.createElement('li'); li.textContent = s.dataset.title; prog.appendChild(li); });
function show(i, push = true) {
  cur = i;
  if (push && i !== (history.state?.step ?? 0)) history.pushState({ step: i }, '', '#step-' + (i + 1));
  steps.forEach((s, k) => (s.hidden = k !== i));
  [...prog.children].forEach((li, k) => {
    li.className = k < i ? 'done' : k === i ? 'now' : '';
    k === i ? li.setAttribute('aria-current', 'step') : li.removeAttribute('aria-current');
  });
  $('#back').style.visibility = i ? 'visible' : 'hidden';
  $('#next').textContent = i === steps.length - 1 ? 'Pay R780 and submit' : 'Next';
  $('#reg-error').hidden = true;
  if (i === 2) prefillShares();
  if (i === steps.length - 1) buildSummary();
  window.scrollTo({ top: $('.reg').offsetTop, behavior: 'smooth' });
  if (typeof saveDraft === 'function') saveDraft();
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
    <div class="addr-wrap"><span class="lbl">Home address</span>${addrHTML()}</div>
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
  id: e.querySelector('.d-id').value.replace(/\s/g, ''), address: addrVal(e.querySelector('.addr')),
  email: e.querySelector('.d-email').value.trim(), phone: e.querySelector('.d-phone').value.trim(),
}));
const getShares = () => [...document.querySelectorAll('.sh')].map((e) => ({
  name: e.querySelector('.s-name').value.trim(), id: e.querySelector('.s-id').value.replace(/\s/g, ''),
  pct: +e.querySelector('.s-pct').value || 0,
}));

function data() {
  const regAddr = addrVal($('#reg-addr'));
  return {
    names: nameMode() === 'name' ? ['#n1', '#n2', '#n3', '#n4'].map((s) => $(s).value.trim()).filter(Boolean) : [],
    register_without_name: nameMode() === 'number', activity: $('#activity').value.trim(),
    directors: getDirectors(), shareholders: getShares(),
    registered_address: regAddr, postal_address: $('#same-post').checked ? regAddr : addrVal($('#post-addr')),
    company_email: $('#co-email').value.trim(), company_phone: $('#co-phone').value.trim(),
    financial_year_end: $('#fye').value, include_bo_filing: $('#include-bo').checked,
  };
}

// ---------- validation: returns a message, or '' if the step is fine ----------
function problem(i) {
  const d = data();
  document.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
  if (i === 0 && nameMode() === 'name' && !d.names.length) return mark($('#n1'), 'Enter at least one company name, or choose “I’ll choose a name later”.');
  if (i === 1) {
    for (const [k, e] of [...document.querySelectorAll('.dir')].entries()) {
      const g = d.directors[k], n = k + 1;
      if (!g.name) return mark(e.querySelector('.d-name'), `Director ${n}: enter the full name.`);
      if (g.id_type === 'id' && !validSAID(g.id)) return mark(e.querySelector('.d-id'), `Director ${n}: that doesn’t look like a valid 13-digit South African ID number. Check it for typing mistakes.`);
      if (g.id_type === 'passport' && g.id.length < 5) return mark(e.querySelector('.d-id'), `Director ${n}: enter the passport number.`);
      const ap = addrCheck(e.querySelector('.addr'), `Director ${n}`); if (ap) return ap;
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
    const rp = addrCheck($('#reg-addr'), 'Registered office'); if (rp) return rp;
    if (!$('#same-post').checked) { const pp = addrCheck($('#post-addr'), 'Postal address'); if (pp) return pp; }
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
let lastRef = '', lastJson = '';
$('#next').addEventListener('click', async () => {
  const err = $('#reg-error'), msg = problem(cur);
  if (msg) { err.textContent = msg; err.hidden = false; return; }
  if (cur < steps.length - 1) return show(cur + 1);

  const btn = $('#next'), payload = data(), json = JSON.stringify(payload);
  btn.disabled = true;
  showLoader('Preparing your registration…');
  try {
    // If they came back from PayFast without changing anything, reuse the saved registration
    const reuse = lastRef && json === lastJson;
    const res = await fetch(`${API_BASE}/api/registrations${reuse ? '/pay' : ''}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: reuse ? JSON.stringify({ reference: lastRef }) : json,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || res.statusText);
    if (!reuse) { lastRef = out.reference; lastJson = json; }
    goToPayfast(out.payfast);
  } catch (ex) {
    hideLoader();
    err.textContent = `We couldn’t send your details: ${ex.message}. Nothing was lost on this page. Please try again in a moment.`;
    err.hidden = false;
    btn.disabled = false;
  }
});
$('#back').addEventListener('click', () => (history.state?.step ? history.back() : show(cur - 1, false)));
$('#add-director').addEventListener('click', addDirector);
$('#add-share').addEventListener('click', () => addShare());
$('#same-post').addEventListener('change', (e) => ($('#post-wrap').hidden = e.target.checked));
$('#reg-form').addEventListener('submit', (e) => e.preventDefault());

$('#reg-addr').innerHTML = addrHTML();
$('#post-addr').innerHTML = addrHTML();
document.querySelectorAll('input[name=namemode]').forEach((r) => r.addEventListener('change', () => ($('#names-wrap').hidden = nameMode() === 'number')));
// Browser/phone Back moves one step back with everything still filled in
history.replaceState({ step: 0 }, '');
window.addEventListener('popstate', (e) => { if (!$('#reg-form').hidden) show(e.state?.step ?? 0, false); });
// Coming back from PayFast: remove the loading screen and keep the form as it was
window.addEventListener('pageshow', (e) => { if (e.persisted) { hideLoader(); $('#next').disabled = false; } });
// ---------- autosave (this browser only, 24 hours) ----------
const DRAFT = 'mw_draft', SKIP = new Set(['auth', 'popia']);
const ctrls = () => [...document.querySelectorAll('#reg-form input, #reg-form select')];
const readVal = (c) => (SKIP.has(c.id) ? '' : c.type === 'checkbox' || c.type === 'radio' ? c.checked : c.value);
let saveTimer;
function saveDraft() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!ctrls().some((c) => /^(text|email|tel|number)$/.test(c.type) && c.value.trim())) return localStorage.removeItem(DRAFT);
      localStorage.setItem(DRAFT, JSON.stringify({ t: Date.now(), step: cur, dirs: document.querySelectorAll('.dir').length, shs: document.querySelectorAll('.sh').length, vals: ctrls().map(readVal) }));
    } catch (e) { /* storage unavailable: ignore */ }
  }, 300);
}
function restoreDraft() {
  let d; try { d = JSON.parse(localStorage.getItem(DRAFT) || 'null'); } catch (e) { d = null; }
  if (!d || Date.now() - d.t > 864e5 || !Array.isArray(d.vals)) return false;
  while (document.querySelectorAll('.dir').length < d.dirs) addDirector();
  for (let i = document.querySelectorAll('.sh').length; i < d.shs; i++) addShare();
  ctrls().forEach((c, i) => {
    const v = d.vals[i];
    if (v === undefined || SKIP.has(c.id)) return;
    if (c.type === 'checkbox' || c.type === 'radio') c.checked = !!v; else c.value = v;
  });
  $('#names-wrap').hidden = nameMode() === 'number';
  $('#post-wrap').hidden = $('#same-post').checked;
  total();
  const step = Math.max(0, Math.min(d.step || 0, steps.length - 2));
  for (let k = 1; k <= step; k++) history.pushState({ step: k }, '', '#step-' + (k + 1));
  show(step, false);
  $('#restored').hidden = false;
  return true;
}
$('#reg-form').addEventListener('input', saveDraft);
$('#reg-form').addEventListener('change', saveDraft);
$('#clear-draft').addEventListener('click', () => { try { localStorage.removeItem(DRAFT); } catch (e) { /* ignore */ } location.href = 'register.html'; });
addDirector();
if (!restoreDraft()) show(0, false);
