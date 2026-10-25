// Animated loading screen shown while we connect to PayFast
let loaderTimer;
function showLoader(msg) {
  let el = document.getElementById('loader');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loader'; el.setAttribute('role', 'alert');
    el.innerHTML = `<div class="ld-ring" aria-hidden="true">${'<i></i>'.repeat(12)}<img src="logo.png" alt="" /></div>
      <p class="ld-msg" id="ld-msg"></p><p class="ld-sub">Please don’t close or refresh this page.</p><p class="ld-lock">Secure payment by PayFast</p>`;
    document.body.appendChild(el);
  }
  document.getElementById('ld-msg').textContent = msg;
  el.hidden = false;
  clearTimeout(loaderTimer);
  loaderTimer = setTimeout(() => { document.getElementById('ld-msg').textContent = 'Still working. Our server is waking up, almost there…'; }, 8000);
}
function hideLoader() { clearTimeout(loaderTimer); const el = document.getElementById('loader'); if (el) el.hidden = true; }

// Posts the signed payment details to PayFast, which opens its secure payment page.
function goToPayfast(p) {
  showLoader('Connecting you securely to PayFast…');
  const f = document.createElement('form');
  f.method = 'POST'; f.action = p.url;
  Object.entries(p.fields).forEach(([k, v]) => {
    const i = document.createElement('input');
    i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i);
  });
  document.body.appendChild(f);
  f.submit();
}
