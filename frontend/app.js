const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
const API_BASE = isLocal ? 'http://localhost:4000' : 'https://madewell-backend.onrender.com';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Sample packages: shown when the backend is asleep or has none yet.
const SAMPLE = [
  { slug: 'starter', name: 'Starter', price_cents: 29900, blurb: 'For a new business that needs the basics.',
    includes: ['business_cards', 'letterhead'] },
  { slug: 'business', name: 'Business', price_cents: 59900, blurb: 'For businesses sending quotes and invoices.', popular: true,
    includes: ['business_cards', 'letterhead', 'invoice', 'quotation'] },
  { slug: 'complete', name: 'Complete', price_cents: 99900, blurb: 'For a full rebrand, ready for clients.',
    includes: ['business_cards', 'letterhead', 'invoice', 'quotation', 'company_profile', 'flyer', 'price_list'] },
];
let usingSample = false;

const COLOURS = ['#f5a623', '#17365d', '#1f7a5c', '#b3263e', '#6b3fa0', '#1d1d1d'];
const state = { view: 'card', colour: COLOURS[0], logo: '' };

async function loadPackages() {
  let list = [];
  try {
    const res = await fetch(`${API_BASE}/api/packages`);
    if (!res.ok) throw new Error();
    list = (await res.json()).packages || [];
  } catch (_) { /* fall through to samples */ }
  if (!list.length) { list = SAMPLE; usingSample = true; }

  const grid = $('#package-grid');
  grid.innerHTML = '';
  list.forEach((p) => {
    const sample = SAMPLE.find((s) => s.slug === p.slug) || {};
    const el = document.createElement('article');
    el.className = 'card' + (p.popular || sample.popular ? ' pop' : '');
    el.innerHTML = `
      ${p.popular || sample.popular ? '<span class="flag">Most chosen</span>' : ''}
      <h3>${esc(p.name)}</h3>
      <p class="for">${esc(p.blurb || sample.blurb || '')}</p>
      <div class="price">R${(p.price_cents / 100).toLocaleString('en-ZA')}</div>
      <ul>${(p.includes || []).map((d) => `<li>${esc(d.replace(/_/g, ' '))}</li>`).join('')}</ul>
      <button class="btn" type="button">Choose ${esc(p.name)}</button>`;
    el.querySelector('button').addEventListener('click', () => choose(p));
    grid.appendChild(el);
  });
}

function choose(p) {
  $('#package_slug').value = p.slug;
  $('#chosen-name').textContent = p.name;
  $('#builder').hidden = false;
  $('#confirmation').hidden = true;
  render();
  $('#builder').scrollIntoView({ behavior: 'smooth' });
  setTimeout(() => $('#biz').focus({ preventScroll: true }), 500);
}

// ---------- live preview ----------
function vals() {
  return {
    biz: $('#biz').value.trim() || 'Your Business Name',
    tagline: $('#tagline').value.trim() || 'What your business does',
    person: $('#person').value.trim() || 'Your Name, Your Role',
    phone: $('#phone').value.trim() || '082 000 0000',
    email: $('#email').value.trim() || 'you@example.com',
    address: $('#address').value.trim() || 'Your street address, City',
  };
}

function render() {
  const v = vals();
  const tpl = document.querySelector('input[name=tpl]:checked').value;
  const logo = state.logo ? `<img src="${state.logo}" alt="" />` : '';
  const stage = $('#stage');
  if (state.view === 'card') {
    stage.innerHTML = `
      <div class="bc t-${tpl}" style="--c:${state.colour}">
        ${logo}
        <div><b>${esc(v.biz)}</b><span>${esc(v.tagline)}</span></div>
        <small>${esc(v.person)}<br>${esc(v.phone)} · ${esc(v.email)}<br>${esc(v.address)}</small>
      </div>`;
  } else {
    stage.innerHTML = `
      <div class="lh t-${tpl}" style="--c:${state.colour}">
        <header>${logo}<div><b>${esc(v.biz)}</b><em>${esc(v.tagline)}</em></div></header>
        <div class="body"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
        <footer>${esc(v.phone)} · ${esc(v.email)} · ${esc(v.address)}</footer>
      </div>`;
  }
}

// colour swatches
COLOURS.forEach((c, i) => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'sw'; b.style.setProperty('--c', c);
  b.setAttribute('role', 'radio'); b.setAttribute('aria-label', `Colour ${i + 1}`);
  b.setAttribute('aria-checked', i === 0);
  b.addEventListener('click', () => {
    state.colour = c;
    document.querySelectorAll('.sw').forEach((s) => s.setAttribute('aria-checked', s === b));
    render();
  });
  $('#swatches').appendChild(b);
});

$('#order-form').addEventListener('input', render);
document.querySelectorAll('.tabs button').forEach((t) =>
  t.addEventListener('click', () => {
    state.view = t.dataset.view;
    document.querySelectorAll('.tabs button').forEach((o) => o.setAttribute('aria-selected', o === t));
    render();
  }));

$('#logo').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) { state.logo = ''; return render(); }
  const r = new FileReader();
  r.onload = () => { state.logo = r.result; render(); };
  r.readAsDataURL(f);
});

// ---------- submit ----------
$('#order-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#form-error');
  const biz = $('#biz'), email = $('#email');
  [biz, email].forEach((i) => i.removeAttribute('aria-invalid'));
  const missing = [];
  if (!biz.value.trim()) { biz.setAttribute('aria-invalid', true); missing.push('your business name'); }
  if (!email.validity.valid || !email.value) { email.setAttribute('aria-invalid', true); missing.push('a valid email address'); }
  if (missing.length) {
    err.textContent = `Please add ${missing.join(' and ')}.`;
    err.hidden = false;
    return (biz.getAttribute('aria-invalid') ? biz : email).focus();
  }
  err.hidden = true;

  const v = vals();
  const body = {
    package_slug: $('#package_slug').value,
    email: email.value.trim(),
    full_name: $('#person').value.split(',')[0].trim() || biz.value.trim(),
    business: { ...v, template: document.querySelector('input[name=tpl]:checked').value, colour: state.colour },
  };

  const done = (id, note) => {
    $('#builder').hidden = true;
    $('#confirmation').hidden = false;
    $('#order-id').textContent = id;
    $('#order-note').textContent = note;
    $('#confirmation').scrollIntoView({ behavior: 'smooth' });
  };

  if (usingSample) {
    return done('DEMO-0001', 'This is a design preview, so no order was created. Payment comes next.');
  }
  try {
    const res = await fetch(`${API_BASE}/api/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const { order } = await res.json();
    done(order.id, 'We’ve saved your details. Payment is the next step and is coming soon.');
  } catch (ex) {
    err.textContent = `We couldn’t save your order: ${ex.message}. Please try again in a moment.`;
    err.hidden = false;
  }
});

loadPackages();
