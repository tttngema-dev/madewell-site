/**
 * Made Well Pro (frontend): crown icon, paywall, promo-code box, plan card, "free document" logic.
 * Needs auth.js (MWAuth) and, to take payment, pay.js (goToPayfast).
 *
 *   MWBilling.status()               -> { pro, price, subscription, trial: { used, doc } }   (cached)
 *   MWBilling.guardDoc(ocid, url)    -> true if this person may fill in that document, else opens the paywall and returns false
 *   MWBilling.openPaywall({reason})  reason: 'doc' | 'alerts' | 'upgrade'
 *   MWBilling.celebrate()            after the free document is done: a friendly "want to do this for every tender?" card
 *   MWBilling.mountPlanCard(el)      the plan box on the dashboard
 *   MWBilling.handleReturn()         call once on the dashboard: handles coming back from PayFast
 */
(function (g) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CROWN = (cls) => '<svg class="mw-crown ' + (cls || '') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M2.6 7.2c-.5-.3-1.2.1-1.1.7L3.3 19c.1.6.6 1 1.2 1h15c.6 0 1.1-.4 1.2-1l1.8-11.1c.1-.6-.6-1-1.1-.7l-4.5 3L12.9 4c-.4-.7-1.4-.7-1.8 0L7.1 10.2l-4.5-3Z"/><rect x="4" y="21" width="16" height="1.6" rx=".8" fill="currentColor"/></svg>';

  let cache = null;
  function status(force) {
    if (!cache || force) cache = MWAuth.api('/api/billing/status').catch((e) => { cache = null; throw e; });
    return cache;
  }
  function changed() { cache = null; g.dispatchEvent(new CustomEvent('mw:billing')); }

  const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (_) { return ''; } };
  const money = (n) => 'R' + (Number(n) % 1 ? Number(n).toFixed(2) : Number(n));
  const perDay = (n) => 'R' + (n / 30).toFixed(2).replace(/\.?0+$/, '');

  /** Is this document locked for this person (free plan, free document already used on a different document)? */
  function locked(s, ocid, url) {
    if (!s || s.pro || !s.trial || !s.trial.used) return false;
    const d = s.trial.doc;
    return !(d && d.ocid === ocid && d.doc_url === url);
  }
  function isTrialDoc(s, ocid, url) {
    return !!(s && !s.pro && s.trial && s.trial.used && s.trial.doc && s.trial.doc.ocid === ocid && s.trial.doc.doc_url === url);
  }

  // ------------------------------------------------------------------ promo code box (used in the paywall and on the plan card)
  function promoBox(onDone) {
    const w = document.createElement('div');
    w.className = 'promo';
    w.innerHTML = '<button type="button" class="promo-toggle" aria-expanded="false">Have a promo code?</button>' +
      '<div class="promo-row" hidden><input type="text" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="40" placeholder="Type your code" aria-label="Promo code">' +
      '<button type="button" class="btn small">Apply</button></div><p class="promo-msg" role="status" hidden></p>';
    const tog = w.querySelector('.promo-toggle'), row = w.querySelector('.promo-row'), inp = row.querySelector('input'), btn = row.querySelector('button'), msg = w.querySelector('.promo-msg');
    const say = (t, cls) => { msg.hidden = !t; msg.textContent = t || ''; msg.className = 'promo-msg ' + (cls || ''); };
    tog.addEventListener('click', () => { row.hidden = !row.hidden; tog.setAttribute('aria-expanded', String(!row.hidden)); if (!row.hidden) inp.focus(); });
    async function apply() {
      const code = inp.value.trim();
      if (!code) { say('Type your promo code first.', 'err'); inp.focus(); return; }
      btn.disabled = true; say('Checking…');
      try {
        const r = await MWAuth.api('/api/billing/redeem', { method: 'POST', body: JSON.stringify({ code }) });
        say(r.lifetime ? 'Code accepted. Pro is yours, with no end date 🎉' : 'Code accepted. Pro is on until ' + fmtDate(r.ends) + ' 🎉', 'ok');
        changed();
        setTimeout(() => onDone && onDone(r), 900);
      } catch (err) { say(err.message || 'That code did not work.', 'err'); btn.disabled = false; inp.focus(); }
    }
    btn.addEventListener('click', apply);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
    return w;
  }

  // ------------------------------------------------------------------ taking payment
  async function startCheckout(btn, msgEl) {
    const old = btn.innerHTML; btn.disabled = true; btn.textContent = 'Connecting to PayFast…';
    try {
      const r = await MWAuth.api('/api/billing/subscribe', { method: 'POST', body: '{}' });
      if (typeof g.goToPayfast !== 'function') throw new Error('Payment page is not loaded. Please refresh and try again.');
      g.goToPayfast(r.payment);
    } catch (err) {
      btn.disabled = false; btn.innerHTML = old;
      if (msgEl) { msgEl.hidden = false; msgEl.className = 'pw-msg err'; msgEl.textContent = err.message || 'Could not start the payment.'; }
      else alert(err.message || 'Could not start the payment.');
    }
  }

  // ------------------------------------------------------------------ the paywall
  const COPY = {
    doc: { eye: 'Your free document is done', h: 'Loved how fast that was? Do it for every tender.', sub: 'You’ve seen how it works. With Pro you can fill in, stamp, sign, attach and send every tender you chase, without the printing, scanning and rework.' },
    alerts: { eye: 'Pro feature', h: 'Let the tenders come to you', sub: 'Every morning we email you the best new tenders that match your business: up to 10 a day, never the same one twice. You’ll hear about them while others are still searching.' },
    download: { eye: 'Your free download is used', h: 'Need to download more?', sub: 'Only Pro members can download more than once. Free accounts get one download in total, and yours is used. With Pro you can download and email as many tender documents as you need, blank or filled in.' },
    export: { eye: 'Your free download is used', h: 'Need to download more?', sub: 'Only Pro members can download more than once. Free accounts get one download in total, and yours is used. With Pro you can download and email as many tender documents as you need, blank or filled in.' },
    upgrade: { eye: 'Made Well Pro', h: 'Win more tenders with less paperwork', sub: 'Stop retyping the same company details into every form. Fill it in once, and every tender becomes a few taps.' },
  };
  const BENEFITS = [
    '<b>Download and email as many documents as you need</b>, blank or filled in',
    '<b>Fill in unlimited tender documents</b>: type, tick, date, stamp and sign on your phone or computer',
    '<b>Attach your company documents</b>: CSD, tax, B-BBEE and more, merged into one ready-to-submit PDF',
    '<b>Email the finished PDF</b> straight to the buyer from the site',
    '<b>Daily tender alerts</b> matched to your business, up to 10 a day',
    '<b>Your company details fill the forms for you</b>: saved once, used every time',
  ];

  let openEl = null;
  function closePaywall() { if (openEl) { openEl.remove(); openEl = null; document.removeEventListener('keydown', onEsc, true); } }
  function onEsc(e) { if (e.key === 'Escape') { e.stopPropagation(); closePaywall(); } }

  async function openPaywall(opts) {
    opts = opts || {};
    closePaywall();
    let s = null;
    try { s = await status(); } catch (_) { /* still show the offer */ }
    if (s && s.pro && !opts.force) { try { opts.onUnlocked && opts.onUnlocked(); } catch (_) {} return; }
    let who = null; try { who = g.MWAuth ? await MWAuth.getUser() : null; } catch (_) {}
    const guest = !who;
    const nextUrl = encodeURIComponent((location.pathname.split('/').pop() || 'index.html') + location.search);
    const price = (s && s.price) || 199;
    const c = COPY[opts.reason] || COPY.upgrade;
    const el = document.createElement('div');
    el.className = 'pw'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'pw-title');
    el.innerHTML = '<div class="pw-card">' +
      '<button type="button" class="pw-x" aria-label="Close">&times;</button>' +
      '<div class="pw-crown">' + CROWN() + '</div>' +
      '<p class="pw-eyebrow">' + esc(c.eye) + '</p><h2 id="pw-title">' + esc(c.h) + '</h2><p class="pw-sub">' + esc(c.sub) + '</p>' +
      '<ul class="pw-list">' + BENEFITS.map((b) => '<li><span>' + b + '</span></li>').join('') + '</ul>' +
      '<p class="pw-free"><b>Still free:</b> browsing tenders, previewing every document and filling in a document, plus one free download in total. Everything you’ve filled in and uploaded stays safe in your account.</p>' +
      '<div class="pw-price"><span class="pw-amt">' + esc(money(price)) + '</span><span class="pw-per">per month</span></div>' +
      '<p class="pw-day">That’s about ' + esc(perDay(price)) + ' a day. Win one tender and Pro has paid for itself many times over.</p>' +
      '<button type="button" class="btn pw-go">' + CROWN('on-gold') + (guest ? ' Create a free account to go Pro' : ' Go Pro · ' + esc(money(price)) + '/month') + '</button>' +
      '<p class="pw-msg" role="status" hidden></p>' +
      '<p class="pw-trust">Secure payment by PayFast · billed monthly to your card · cancel any time from your dashboard, no contract</p>' +
      (guest ? '<p class="promo"><span class="plan-note">Already have an account? <a class="mini-link" href="login.html?next=' + nextUrl + '">Sign in</a></span></p>' : '<div class="pw-promo"></div>') +
      '<button type="button" class="pw-later">Maybe later</button></div>';
    document.body.appendChild(el);
    openEl = el;
    document.addEventListener('keydown', onEsc, true);
    const card = el.querySelector('.pw-card'), msg = el.querySelector('.pw-msg'), go = el.querySelector('.pw-go');
    const promoSlot = el.querySelector('.pw-promo');
    if (promoSlot) promoSlot.appendChild(promoBox(() => {
      card.innerHTML = '<div class="pw-done"><div class="pw-crown">' + CROWN() + '</div><h2>You’re in. Welcome to Pro!</h2><p class="pw-sub">Everything is unlocked. Go and win some tenders.</p><button type="button" class="btn pw-ok">Let’s go</button></div>';
      card.querySelector('.pw-ok').addEventListener('click', () => { closePaywall(); try { opts.onUnlocked && opts.onUnlocked(); } catch (_) {} });
    }));
    go.addEventListener('click', () => {
      if (guest) { if (g.MWLoader) MWLoader.show('Taking you to sign up…'); location.href = 'signup.html?next=' + nextUrl; return; }
      startCheckout(go, msg);
    });
    const dismiss = () => { closePaywall(); try { opts.onClose && opts.onClose(); } catch (_) {} };
    el.querySelector('.pw-x').addEventListener('click', dismiss);
    el.querySelector('.pw-later').addEventListener('click', dismiss);
    el.addEventListener('mousedown', (e) => { if (e.target === el) dismiss(); });
    go.focus();
  }

  // A small "are you sure?" so nobody wastes their one free go by accident
  function confirmUse(o) {
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'pw'; el.setAttribute('role', 'alertdialog'); el.setAttribute('aria-modal', 'true');
      el.innerHTML = '<div class="pw-card" style="max-width:26rem"><div class="pw-crown">' + CROWN() + '</div><h2>' + esc(o.h) + '</h2><p class="pw-sub">' + esc(o.text) + '</p>' +
        '<button type="button" class="btn pw-go">' + esc(o.yes) + '</button><button type="button" class="pw-later">Cancel</button></div>';
      const done = (v) => { document.removeEventListener('keydown', key, true); el.remove(); resolve(v); };
      const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
      document.addEventListener('keydown', key, true);
      document.body.appendChild(el);
      el.querySelector('.pw-go').addEventListener('click', () => done(true));
      el.querySelector('.pw-later').addEventListener('click', () => done(false));
      el.addEventListener('mousedown', (e) => { if (e.target === el) done(false); });
      el.querySelector('.pw-go').focus();
    });
  }
  const markUsed = (s) => { cache = Promise.resolve(Object.assign({}, s, { download: { used: true }, export: { used: true } })); };
  const say = (m) => { try { document.querySelectorAll('.toast-soon').forEach((x) => x.remove()); const n = document.createElement('div'); n.className = 'toast-soon'; n.setAttribute('role', 'status'); n.textContent = m; document.body.appendChild(n); setTimeout(() => n.remove(), 3500); } catch (_) {} };
  // a signed-out visitor's one download is remembered in two places, so private browsing cannot hide it
  const GKEY = 'mw:dl1';
  const guestUsed = () => { try { if (localStorage.getItem(GKEY)) return true; } catch (_) {} return /(?:^|; )mw_dl1=1/.test(document.cookie); };
  const guestMark = (v) => { let ok = false; try { localStorage.setItem(GKEY, v); ok = true; } catch (_) {} try { document.cookie = 'mw_dl1=1; max-age=31536000; path=/; SameSite=Lax'; ok = ok || /mw_dl1=1/.test(document.cookie); } catch (_) {} return ok; };

  /**
   * Free plan: ONE tender document download, once. Not the same document again, not another one. Pro: unlimited.
   * true = go ahead and download. false = the paywall has been shown (or they cancelled).
   */
  async function allowDownload(ocid, url, title) {
    let user = null;
    try { user = g.MWAuth ? await MWAuth.getUser() : null; } catch (_) {}
    const ask = () => confirmUse({ h: 'Use your free download?', text: 'Free accounts get one download in total, for the whole site. This will be it, so choose the document you really need. You can still preview and fill in documents, and Pro lets you download and email as many as you need.', yes: 'Download it' });
    if (user) {
      const post = (extra) => MWAuth.api('/api/billing/download', { method: 'POST', body: JSON.stringify(Object.assign({ ocid: ocid || '', doc_url: url, title: title || '' }, extra)) });
      let d;
      try { d = await post({ dry: true }); }                                  // "may I?" Nothing is used up. Pro people are told so here.
      catch (err) {
        if (err && err.status === 402) { changed(); openPaywall({ reason: 'download' }); return false; }
        say('We could not reach Made Well. Check your connection and try again.'); return false;
      }
      if (d.pro) return true;                                                  // Pro: no questions, no limits
      if (!(await ask())) return false;
      try { await post({}); changed(); return true; }
      catch (err) {
        if (err && err.status === 402) { changed(); openPaywall({ reason: 'download' }); return false; }
        say('We could not reach Made Well. Check your connection and try again.'); return false;
      }
    }
    if (guestUsed()) { openPaywall({ reason: 'download' }); return false; }
    if (!(await ask())) return false;
    if (!guestMark(JSON.stringify({ ocid: ocid || '', url }))) { openPaywall({ reason: 'download' }); return false; } // a browser that remembers nothing must sign in
    return true;
  }

  /**
   * The finished filled-in PDF is the same one free download. Pro: unlimited and never asked.
   * true = go ahead. false = the paywall has been shown (or they cancelled).
   */
  async function allowExport(ocid, url, title) {
    const post = (extra) => MWAuth.api('/api/billing/export', { method: 'POST', body: JSON.stringify(Object.assign({ ocid: ocid || '', doc_url: url || '', title: title || '' }, extra)) });
    let d;
    try { d = await post({ dry: true }); }
    catch (err) {
      if (err && err.status === 402) { changed(); openPaywall({ reason: (err.data && err.data.reason) || 'export' }); return false; }
      say('We could not reach Made Well. Check your connection and try again.'); return false;
    }
    if (d.pro) return true;
    if (!(await confirmUse({ h: 'Use your free download?', text: 'Free accounts get one download in total, for the whole site, and this finished document will use it. You can keep editing it and fill in other documents. Pro lets you download and email as many as you need.', yes: 'Continue' }))) return false;
    try { await post({}); changed(); return true; }
    catch (err) {
      if (err && err.status === 402) { changed(); openPaywall({ reason: (err.data && err.data.reason) || 'export' }); return false; }
      say('We could not reach Made Well. Check your connection and try again.'); return false;
    }
  }

  /** Emailing a finished document uses the same one free download. The server records it only after the email really goes out. */
  async function confirmEmailUse(ocid, url) {
    let d;
    try { d = await MWAuth.api('/api/billing/export', { method: 'POST', body: JSON.stringify({ ocid: ocid || '', doc_url: url || '', dry: true }) }); }
    catch (err) {
      if (err && err.status === 402) { changed(); openPaywall({ reason: (err.data && err.data.reason) || 'export' }); return false; }
      say('We could not reach Made Well. Check your connection and try again.'); return false;
    }
    if (d.pro) return true;                                                    // Pro: never asked
    return confirmUse({ h: 'Use your free download?', text: 'Free accounts get one download in total, and emailing this finished document will use it. Pro lets you download and email as many as you need.', yes: 'Send it' });
  }

  // Someone who downloaded their one free document before signing up: carry that over to their account (no second free one)
  (async function claimGuestDownload() {
    try {
      let raw = null; try { raw = localStorage.getItem('mw:dl1'); } catch (_) {}
      if (!raw && guestUsed()) raw = '{}';
      if (!raw || !g.MWAuth) return;
      const u = await MWAuth.getUser();
      if (!u) return;
      const x = JSON.parse(raw);
      await MWAuth.api('/api/billing/download', { method: 'POST', body: JSON.stringify({ ocid: x.ocid || '', doc_url: x.url || 'carried-over', title: '', claim: true }) });
      try { localStorage.removeItem('mw:dl1'); } catch (_) {}
      document.cookie = 'mw_dl1=; max-age=0; path=/'; cache = null;
    } catch (_) { /* try again next page */ }
  })();

  /** true = go ahead. false = the paywall has been shown instead. */
  async function guardDoc(ocid, url) {
    try {
      const r = await MWAuth.api('/api/billing/status?ocid=' + encodeURIComponent(ocid) + '&doc_url=' + encodeURIComponent(url));
      cache = Promise.resolve(r);
      if (r.can_open === false) { openPaywall({ reason: 'doc' }); return false; }
    } catch (_) { /* can't tell: let them in; the server decides when they save */ }
    return true;
  }

  // ------------------------------------------------------------------ the moment after the free document is finished
  async function celebrate() {
    try {
      if (sessionStorage.getItem('mw:cheer')) return;
      const s = await status(true);
      if (s.pro) return;
      sessionStorage.setItem('mw:cheer', '1');
      setTimeout(() => {
        const el = document.createElement('div');
        el.className = 'pw-cheer'; el.setAttribute('role', 'status');
        el.innerHTML = '<strong>' + CROWN() + ' That’s your free document done 🎉</strong><p>Imagine that for every tender you go after. Pro is ' + esc(money(s.price)) + '/month, cancel any time.</p>' +
          '<div class="pw-cheer-row"><button type="button" class="btn small">See Pro</button><button type="button" class="pw-cheer-x">Not now</button></div>';
        document.body.appendChild(el);
        el.querySelector('.btn').addEventListener('click', () => { el.remove(); openPaywall({ reason: 'doc' }); });
        el.querySelector('.pw-cheer-x').addEventListener('click', () => el.remove());
      }, 1600);
    } catch (_) { /* never get in the way of a download */ }
  }

  // ------------------------------------------------------------------ dashboard plan card
  function mountPlanCard(box) {
    async function render() {
      let s;
      try { s = await status(); } catch (err) { console.warn('[billing]', err.message); box.hidden = true; return; }
      const sub = s.subscription || {};
      let ico = CROWN(), cls = 'plan', title = '', text = '', act = '';
      if (s.pro && sub.source === 'payfast' && sub.status === 'active') {
        cls += ' is-pro'; title = 'Made Well Pro · active';
        text = 'You have everything unlocked. Next payment around ' + fmtDate(sub.current_period_end) + '.';
      } else if (s.pro && sub.source === 'payfast') {
        cls += ' is-pro'; title = 'Made Well Pro · ends ' + fmtDate(sub.current_period_end);
        text = 'Your subscription won’t renew. You keep everything until then.';
        act = '<button type="button" class="btn small" data-a="sub">Restart Pro</button>';
      } else if (s.pro && sub.lifetime) {
        cls += ' is-pro'; title = 'Made Well Pro · free access';
        text = 'Unlocked with promo code ' + (sub.promo_code || '') + ', with no end date.';
      } else if (s.pro) {
        cls += ' is-pro'; title = 'Made Well Pro · free until ' + fmtDate(sub.current_period_end);
        text = 'Unlocked with promo code ' + (sub.promo_code || '') + '. Want to keep it after that?';
        act = '<button type="button" class="btn small ghost-btn" data-a="sub">Keep Pro · ' + esc(money(s.price)) + '/month</button>';
      } else if (!s.trial.used) {
        title = 'Free plan · your first document is on us';
        text = 'Open any tender document, fill it in, attach your company documents and download or email it. No payment needed.';
        act = '<button type="button" class="btn small ghost-btn" data-a="up">' + CROWN() + ' See Pro</button>';
      } else {
        cls += ' is-hot'; title = 'You’ve used your free document';
        text = 'Your work and company profile are safe. Go Pro to keep filling in tenders and to get daily tender alerts.';
        act = '<button type="button" class="btn" data-a="up">' + CROWN('on-gold') + ' Go Pro · ' + esc(money(s.price)) + '/month</button>';
      }
      const dots = !s.pro ? '<span class="plan-dots" aria-label="' + (s.trial.used ? 'Free document used' : '1 free document left') + '"><i class="' + (s.trial.used ? '' : 'on') + '"></i></span>' : '';
      box.hidden = false; box.className = cls;
      box.innerHTML = '<div class="plan-ico">' + ico + '</div><div class="plan-body"><strong>' + esc(title) + '</strong><span>' + esc(text) + '</span>' + dots + '</div><div class="plan-act">' + act + '</div>';
      if (!s.pro) box.appendChild(promoBox(() => { cache = null; render(); }));
      box.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', async () => {
        const a = b.dataset.a;
        if (a === 'up') openPaywall({ reason: s.trial.used ? 'doc' : 'upgrade' });
        else if (a === 'sub') startCheckout(b, null);
        else if (a === 'cancel') {
          if (!confirm('Cancel Made Well Pro? You keep Pro until ' + fmtDate(sub.current_period_end) + ', and you won’t be charged again.')) return;
          b.disabled = true; b.textContent = 'Cancelling…';
          try { await MWAuth.api('/api/billing/cancel', { method: 'POST', body: '{}' }); changed(); }
          catch (err) { alert(err.message || 'Could not cancel.'); b.disabled = false; b.textContent = 'Cancel subscription'; }
        }
      }));
    }
    g.addEventListener('mw:billing', render);
    return render();
  }

  // ---- Manage subscription: a quiet link at the bottom of the dashboard. Plan details, and where cancelling lives. ----
  async function openManage() {
    let s; try { s = await status(true); } catch (_) { say('We could not load your plan. Please try again.'); return; }
    const sub = s.subscription || {};
    const el = document.createElement('div');
    el.className = 'pw'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
    const card = document.createElement('div'); card.className = 'pw-card'; card.style.maxWidth = '28rem';
    el.appendChild(card); document.body.appendChild(el);
    const close = () => { document.removeEventListener('keydown', onKey, true); el.remove(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    el.addEventListener('mousedown', (e) => { if (e.target === el) close(); });
    const frame = (title, bodyHtml, buttons) => {
      card.innerHTML = '<button type="button" class="pw-x" aria-label="Close">&times;</button><h2 style="margin-top:.2rem">' + esc(title) + '</h2>' + bodyHtml + '<div id="mg-btns" style="display:grid;gap:.5rem;margin-top:1rem"></div><p class="pw-msg" role="status" hidden></p>';
      card.querySelector('.pw-x').addEventListener('click', close);
      const box = card.querySelector('#mg-btns');
      buttons.forEach((b) => { const x = document.createElement('button'); x.type = 'button'; x.className = b.cls || 'btn'; x.textContent = b.label; x.addEventListener('click', () => b.fn(x)); box.appendChild(x); });
    };
    const msg = (t, err) => { const m = card.querySelector('.pw-msg'); m.hidden = !t; m.className = 'pw-msg ' + (err ? 'err' : 'ok'); m.textContent = t || ''; };
    const ends = fmtDate(sub.current_period_end);
    const goPro = { label: 'Go Pro · ' + money(s.price) + '/month', cls: 'btn', fn: () => { close(); openPaywall({ reason: 'upgrade' }); } };
    if (!s.pro) { frame('Your subscription', '<p class="pw-sub">You are on the free plan, so there is nothing to cancel.</p>', [goPro, { label: 'Close', cls: 'pw-later', fn: close }]); return; }
    if (sub.source === 'promo') {
      frame('Your subscription', '<p class="pw-sub">You have Pro through promo code <b>' + esc(sub.promo_code || '') + '</b>' + (sub.lifetime ? ', with no end date.' : ', until ' + esc(ends) + '.') + ' You are not being charged, so there is nothing to cancel.</p>', [].concat(sub.lifetime ? [] : [{ label: 'Keep Pro after that · ' + money(s.price) + '/month', cls: 'btn', fn: (b) => startCheckout(b, card.querySelector('.pw-msg')) }], [{ label: 'Close', cls: 'pw-later', fn: close }]));
      return;
    }
    if (sub.status === 'cancelled') {
      frame('Your subscription', '<p class="pw-sub">Your subscription is cancelled and will not renew. You keep Pro until <b>' + esc(ends) + '</b>.</p>', [{ label: 'Restart Pro · ' + money(s.price) + '/month', cls: 'btn', fn: (b) => startCheckout(b, card.querySelector('.pw-msg')) }, { label: 'Close', cls: 'pw-later', fn: close }]);
      return;
    }
    const first = () => frame('Your subscription', '<p class="pw-sub"><b>Made Well Pro</b>, ' + esc(money(s.price)) + ' a month. Next payment around <b>' + esc(ends) + '</b>.</p><p class="fine">You can cancel at any time. See our <a href="refund-policy.html">Refund Policy</a>.</p>', [{ label: 'Keep my subscription', cls: 'btn', fn: close }, { label: 'Cancel subscription', cls: 'pw-later', fn: second }]);
    const second = () => frame('Cancel Made Well Pro?', '<p class="pw-sub">You keep Pro until <b>' + esc(ends) + '</b>, the end of the month you have paid for, and you will not be charged again.</p>', [{ label: 'Keep my subscription', cls: 'btn', fn: close }, { label: 'Yes, cancel it', cls: 'pw-later', fn: async (b) => {
      b.disabled = true; b.textContent = 'Cancelling…';
      try { await MWAuth.api('/api/billing/cancel', { method: 'POST', body: '{}' }); changed(); frame('Subscription cancelled', '<p class="pw-sub">Done. You keep Pro until <b>' + esc(ends) + '</b> and you will not be charged again.</p>', [{ label: 'Close', cls: 'btn', fn: close }]); }
      catch (err) { b.disabled = false; b.textContent = 'Yes, cancel it'; msg(err.message || 'We could not cancel it. Please try again, or contact us on WhatsApp.', true); }
    } }]);
    first();
  }

  // Small things that follow the plan: the nav button, and any [data-pro-only] / [data-free-only] element
  async function syncNav() {
    let s = null;
    try { s = await status(); } catch (_) { return; }
    document.querySelectorAll('[data-pro-nav]').forEach((a) => {
      a.hidden = false;
      a.innerHTML = s.pro ? CROWN() + ' Pro' : CROWN() + ' Go Pro';
      a.onclick = s.pro ? null : (e) => { e.preventDefault(); openPaywall({ reason: s.trial.used ? 'doc' : 'upgrade' }); };
      a.setAttribute('aria-label', s.pro ? 'You have Made Well Pro' : 'Go Pro, ' + money(s.price) + ' a month');
    });
  }
  g.addEventListener('mw:billing', syncNav);

  // Coming back from PayFast: wait (up to ~40 s) for PayFast's confirmation to reach our server
  async function handleReturn() {
    const q = new URLSearchParams(location.search);
    const toast = (t, err) => { const d = document.createElement('div'); d.className = 'toast' + (err ? ' err' : ''); d.textContent = t; d.setAttribute('role', 'status'); document.body.appendChild(d); setTimeout(() => d.remove(), 6000); };
    if (q.get('subscribe') === 'cancelled') { history.replaceState(null, '', location.pathname + location.hash); toast('No problem. Nothing was charged.'); return; }
    if (!q.get('subscribed')) return;
    history.replaceState(null, '', location.pathname + location.hash);
    toast('Payment received. Switching Pro on…');
    for (let i = 0; i < 16; i++) {
      try { const s = await status(true); if (s.pro) { changed(); toast('Welcome to Pro 👑 Everything is unlocked.'); return; } } catch (_) {}
      await new Promise((r) => setTimeout(r, 2500));
    }
    toast('Your payment is still being confirmed. Pro will switch on by itself in a minute. Refresh this page shortly.');
  }

  g.MWBilling = { openManage, status, changed, locked, isTrialDoc, guardDoc, allowDownload, allowExport, confirmEmailUse, openPaywall, celebrate, mountPlanCard, syncNav, handleReturn, crown: CROWN, promoBox };
})(window);
