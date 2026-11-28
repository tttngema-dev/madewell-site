/* Made Well shared page behaviour: mobile menu, "you are here", signed-in nav, "coming soon" links. No libraries needed. */
(function () {
  const d = document, root = d.documentElement;
  root.classList.add('js-nav');

  // which page are we on?
  const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  d.querySelectorAll('.site-nav a[href]').forEach((a) => {
    const h = (a.getAttribute('href') || '').split('#')[0].split('?')[0].toLowerCase();
    if (h && h === here) a.setAttribute('aria-current', 'page');
  });
  // pages that belong to a section keep that section lit
  const SECTION = { 'register.html': 'services.html', 'beneficial-ownership.html': 'services.html', 'dashboard.html': 'dashboard.html' };
  if (SECTION[here]) { const a = d.querySelector('.site-nav a[href="' + SECTION[here] + '"]'); if (a) a.setAttribute('aria-current', 'page'); }

  // mobile menu
  const btn = d.querySelector('.nav-toggle'), nav = d.getElementById('site-nav');
  if (btn && nav) {
    const set = (open) => { nav.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open)); btn.textContent = open ? '✕' : '☰'; };
    btn.addEventListener('click', () => set(!nav.classList.contains('open')));
    d.addEventListener('keydown', (e) => { if (e.key === 'Escape') set(false); });
    d.addEventListener('click', (e) => { if (!nav.contains(e.target) && !btn.contains(e.target)) set(false); });
    nav.addEventListener('click', (e) => { if (e.target.closest('a')) set(false); });
  }

  // signed in? (read from this browser, no network) so the menu shows Dashboard instead of Sign in
  let signedIn = false;
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/^sb-.+-auth-token$/.test(k) && localStorage.getItem(k)) { signedIn = true; break; } } } catch (_) {}
  d.querySelectorAll('[data-auth="guest"]').forEach((el) => { el.hidden = signedIn; });
  d.querySelectorAll('[data-auth="user"]').forEach((el) => { el.hidden = !signedIn; });

  // Business Tools are coming later: the link stays visible but does nothing yet except say so.
  // To switch it on later, give the links a real href and remove data-soon.
  let t;
  d.addEventListener('click', (e) => {
    const a = e.target.closest('[data-soon]');
    if (!a) return;
    e.preventDefault();
    clearTimeout(t); d.querySelectorAll('.toast-soon').forEach((x) => x.remove());
    const n = d.createElement('div'); n.className = 'toast-soon'; n.setAttribute('role', 'status'); n.textContent = 'Business Tools are coming soon.';
    d.body.appendChild(n); t = setTimeout(() => n.remove(), 2600);
  });

  // Branded loading screen (styles in site.css). MWLoader.show('Opening your document…') / MWLoader.hide()
  let safety;
  window.MWLoader = {
    show(msg, maxMs) {
      root.style.setProperty('--mw-msg', JSON.stringify(msg || 'Loading…'));
      root.classList.add('mw-loading');
      clearTimeout(safety); safety = setTimeout(() => root.classList.remove('mw-loading'), maxMs || 20000); // never leave anyone stuck behind it
    },
    hide() { clearTimeout(safety); root.classList.remove('mw-loading'); },
  };
  if (root.classList.contains('mw-loading')) { clearTimeout(safety); safety = setTimeout(() => root.classList.remove('mw-loading'), 20000); }
  window.addEventListener('pageshow', (e) => { if (e.persisted) window.MWLoader.hide(); }); // back button

  // Any link marked data-go-pro opens the "Go Pro" pop-up right there (no detour via the pricing page).
  // The pop-up's code is only fetched when someone clicks, so pages stay fast. If anything fails, the link's own address is used.
  let proLoading = null;
  function addScript(src) { return new Promise((res, rej) => { const s = d.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src)); d.head.appendChild(s); }); }
  function loadPro() {
    if (window.MWBilling) return Promise.resolve();
    if (proLoading) return proLoading;
    if (!d.querySelector('link[href$="billing.css"]')) { const l = d.createElement('link'); l.rel = 'stylesheet'; l.href = '/billing.css'; d.head.appendChild(l); }
    const steps = [];
    if (!window.MADEWELL) steps.push('/config.js');
    if (!window.supabase) steps.push('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
    steps.push('/auth.js', '/pay.js', '/billing.js');
    proLoading = steps.reduce((p, src) => p.then(() => addScript(src)), Promise.resolve()).catch((e) => { proLoading = null; throw e; });
    return proLoading;
  }
  d.addEventListener('click', (e) => {
    const a = e.target.closest('[data-go-pro]');
    if (!a) return;
    e.preventDefault();
    window.MWLoader && window.MWLoader.show('One moment…', 8000);
    loadPro().then(() => { window.MWLoader && window.MWLoader.hide(); window.MWBilling.openPaywall({ reason: 'upgrade' }); })
      .catch(() => { window.MWLoader && window.MWLoader.hide(); location.href = a.getAttribute('href') || '/pricing'; });
  });
})();
