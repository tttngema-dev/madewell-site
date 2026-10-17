// Points at your local backend during development.
// We'll change this to your Render URL when we deploy in Step 1.5.
const API_BASE = window.MADEWELL_API_BASE || 'http://localhost:4000';

const $ = (sel) => document.querySelector(sel);

async function loadPackages() {
  const res = await fetch(`${API_BASE}/api/packages`);
  const { packages } = await res.json();
  const wrap = $('#packages');
  wrap.innerHTML = '';

  packages.forEach((p) => {
    const el = document.createElement('article');
    el.className = 'card';
    el.innerHTML = `
      <h3>${p.name}</h3>
      <div class="price">R${(p.price_cents / 100).toFixed(2)}</div>
      <ul>${p.includes.map((d) => `<li>${d.replace(/_/g, ' ')}</li>`).join('')}</ul>
      <button data-slug="${p.slug}" data-name="${p.name}">Choose package</button>
    `;
    wrap.appendChild(el);
  });

  wrap.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('#package_slug').value = btn.dataset.slug;
      $('#chosen-package-name').textContent = btn.dataset.name;
      $('#order-form-wrap').hidden = false;
      $('#order-form-wrap').scrollIntoView({ behavior: 'smooth' });
    });
  });
}

$('#order-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    package_slug: $('#package_slug').value,
    email: $('#email').value.trim(),
    full_name: $('#full_name').value.trim(),
  };

  const res = await fetch(`${API_BASE}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(`Could not create order: ${err.error || res.statusText}`);
    return;
  }

  const { order } = await res.json();
  $('#order-form-wrap').hidden = true;
  $('#confirmation').hidden = false;
  $('#order-id').textContent = order.id;
  $('#order-status').textContent = order.status;
});

loadPackages();