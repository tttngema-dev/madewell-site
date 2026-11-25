(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('en-ZA', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  }

  function daysUntil(iso) {
    if (!iso) return null;
    return Math.ceil((new Date(iso) - new Date()) / 86400000);
  }

  async function init() {
    try { await boot(); } finally { if (window.MWLoader) MWLoader.hide(); }
  }
  async function boot() {
    const user = await MWAuth.requireUser('login.html');
    if (!user) { if (window.MWLoader) MWLoader.show('Taking you to sign in…'); return; }
    await MWAuth.hydrateNav();
    const nm = (user.email || '').split('@')[0]; const hello = $('#hello-name'); if (hello && nm) hello.textContent = '';
    $('#btn-signout').addEventListener('click', async () => {
      if (window.MWLoader) MWLoader.show('Signing you out…');
      await MWAuth.signOut();
      location.href = 'index.html';
    });
    currentUser = user;
    if (window.MWBilling) { MWBilling.mountPlanCard($('#plan-card')); MWBilling.syncNav(); MWBilling.handleReturn(); markAlertsCrown(); window.addEventListener('mw:billing', () => { markAlertsCrown(); refreshDocBoxes(); }); }
    const pending = await applyPending(); // a tender they tried to save / fill in before signing in or registering
    await Promise.all([loadSaved(), loadProfile(), loadCompanyDocs(), loadSignature()]);
    await loadAlerts();
    if (pending && pending.type === 'fill') {
      history.replaceState(null, '', location.pathname + '?open=' + encodeURIComponent(pending.tender.ocid) + '&doc=' + (pending.doc | 0));
    } else if (pending) {
      toast('Saved to your dashboard ✓');
      const card = document.querySelector('[data-docs-for="' + CSS.escape(pending.tender.ocid) + '"]');
      const c = card && (card.closest('.tcard') || card.parentElement);
      if (c) { c.classList.add('just-saved'); c.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    }
    await autoOpenFromUrl();
  }

  let currentUser = null;
  function toast(text, err) {
    const t = document.createElement('div');
    t.className = 'toast' + (err ? ' err' : ''); t.textContent = text; t.setAttribute('role', 'status');
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5200);
  }
  async function applyPending() {
    const p = MWAuth.takePending();
    if (!p || !p.tender || !p.tender.ocid) return null;
    try { await MWAuth.api('/api/account/saved', { method: 'POST', body: JSON.stringify(p.tender) }); return p; }
    catch (err) { toast('Could not save that tender: ' + (err.message || 'try again from the tenders page'), true); return null; }
  }

  // tenders.html sends people here with ?open=<ocid>&doc=<index> after "Save & fill in"
  async function autoOpenFromUrl() {
    const params = new URLSearchParams(location.search);
    const ocid = params.get('open');
    if (!ocid) return;
    history.replaceState(null, '', location.pathname);
    const item = savedItems.find((i) => i.ocid === ocid);
    if (!item) return;
    const btn = document.querySelector('[data-docs-for="' + CSS.escape(ocid) + '"]');
    if (btn) { btn.hidden = false; await renderDocs(item, btn); btn.scrollIntoView({ block: 'center' }); }
    const docs = await documentsFor(item);
    const d = docs[parseInt(params.get('doc'), 10)];
    if (d && MWDocViewer.canPreview(d)) await openDoc(item, d);
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-share]');
    if (!b) return;
    const item = savedItems.find((i) => String(i.id) === b.dataset.share);
    if (item && window.MWShare) MWShare.tender({ ocid: item.ocid, title: item.title, buyer: item.buyer, closingDate: item.closing_date }, b);
  });

  let savedItems = [];
  let edits = []; // filled-in documents (id, ocid, doc_url, updated_at)
  async function loadEdits() {
    try { edits = (await MWAuth.api('/api/account/doc-edits')).items || []; } catch (_) { edits = []; }
  }
  const editFor = (ocid, url) => edits.find((e) => e.ocid === ocid && e.doc_url === url);

  async function documentsFor(item) {
    if (Array.isArray(item.documents) && item.documents.length) return item.documents;
    // older saves: look the documents up from the live tender feed
    try {
      const r = await MWAuth.api('/api/tenders/' + encodeURIComponent(item.ocid));
      item.documents = (r.item && r.item.documents) || [];
    } catch (_) { item.documents = item.documents || []; }
    return item.documents;
  }

  async function openDoc(item, d) {
    if (window.MWBilling && !(await MWBilling.guardDoc(item.ocid, d.url))) return; // free document already used: the paywall shows instead
    MWDocViewer.open({
      url: d.url, title: d.title, tenderTitle: item.title || item.ocid, ocid: item.ocid, editable: true,
      onClose: async () => { await loadEdits(); const box = document.querySelector('[data-docs-for="' + CSS.escape(item.ocid) + '"]'); if (box && !box.hidden) renderDocs(item, box); },
    });
  }

  async function renderDocs(item, box) {
    box.innerHTML = '<p class="muted">Loading documents…</p>';
    const docs = await documentsFor(item);
    if (!docs.length) {
      box.innerHTML = '<p class="muted">No documents were attached to this tender in the data feed. Check the official portal.</p>';
      return;
    }
    box.innerHTML = '';
    let bs = null;
    if (window.MWBilling) { try { bs = await MWBilling.status(); } catch (_) {} }
    docs.forEach((d) => {
      const e = editFor(item.ocid, d.url);
      const lock = bs && MWBilling.locked(bs, item.ocid, d.url) && MWDocViewer.canPreview(d);
      const free = bs && (MWBilling.isTrialDoc(bs, item.ocid, d.url) || (!bs.pro && !bs.trial.used && MWDocViewer.canPreview(d)));
      const row = document.createElement('div');
      row.className = 'doc-line';
      const meta = [d.format, e ? 'Filled in · edited ' + formatDate(e.updated_at) : ''].filter(Boolean).map(esc).join(' · ') + (free ? ' <span class="free-tag">Free document</span>' : '');
      const can = MWDocViewer.canPreview(d);
      row.innerHTML = `<div class="doc-info"><strong>${esc(d.title)}</strong><span>${meta}</span></div>` +
        (can
          ? `<button type="button" class="btn small ${lock ? 'dv-lock' : ''}">${lock ? MWBilling.crown('on-gold') + ' ' : ''}${e ? 'Continue filling in' : 'Open &amp; fill in'}</button>`
          : `<a class="btn small ghost-btn" data-dl href="#download" role="button">Download</a>`);
      const b = row.querySelector('button');
      if (b) b.addEventListener('click', () => openDoc(item, d));
      const dl = row.querySelector('a[data-dl]');
      if (dl) dl.addEventListener('click', async (ev) => {
        ev.preventDefault();
        if (window.MWBilling && !(await MWBilling.allowDownload(item.ocid, d.url, d.title))) return; // free plan: one download
        const go = document.createElement('a'); go.href = d.url; go.target = '_blank'; go.rel = 'noopener'; document.body.appendChild(go); go.click(); go.remove();
      });
      box.appendChild(row);
    });
  }

  // Crown on the Tender alerts tab while on the free plan; re-draw open document lists when the plan changes
  async function markAlertsCrown() {
    if (!window.MWBilling) return;
    let s = null; try { s = await MWBilling.status(); } catch (_) { return; }
    const c = $('#alerts-crown'), t = $('#al-protag');
    if (c) { c.hidden = !!s.pro; c.innerHTML = s.pro ? '' : MWBilling.crown() + ' '; }
    if (t) { t.hidden = !!s.pro; t.innerHTML = s.pro ? '' : MWBilling.crown() + ' Pro'; }
  }
  function refreshDocBoxes() {
    document.querySelectorAll('.saved-docs').forEach((box) => {
      if (box.hidden) return;
      const item = savedItems.find((i) => i.ocid === box.dataset.docsFor);
      if (item) renderDocs(item, box);
    });
  }
  // The server says "Pro needed" (402): show the paywall instead of an error
  function proGate(err) {
    if (err && err.status === 402 && window.MWBilling) { MWBilling.openPaywall({ reason: (err.data && err.data.reason) || 'upgrade' }); return true; }
    return false;
  }

  const STATUSES = ['watching', 'applying', 'submitted', 'won', 'lost'];
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  let activeFilter = 'all';

  function dueInfo(iso) {
    const d = daysUntil(iso);
    if (d == null) return { cls: '', html: '<b>No closing date</b>' };
    if (new Date(iso) < new Date()) {
      const ago = Math.max(1, Math.round((Date.now() - new Date(iso)) / 86400000));
      return { cls: 'closed', html: '<b>Closed</b> ' + (ago === 1 ? 'yesterday' : ago + ' days ago') + ' · ' + esc(formatDate(iso)) };
    }
    const label = d <= 0 ? 'Closes today' : d === 1 ? 'Closes tomorrow' : 'Closes in ' + d + ' days';
    return { cls: d <= 3 ? 'urgent' : d <= 7 ? 'warn' : '', html: '<b>' + label + '</b> · ' + esc(formatDate(iso)) };
  }

  function setStat(name, v) { const el = document.querySelector('[data-stat="' + name + '"]'); if (el) el.textContent = v; }

  function renderStats(items) {
    const open = (i) => ['watching', 'applying'].includes(i.status || 'watching');
    setStat('saved', items.length);
    setStat('soon', items.filter((i) => { const d = daysUntil(i.closing_date); return open(i) && d != null && d >= 0 && d <= 7; }).length);
    setStat('progress', items.filter((i) => ['applying', 'submitted'].includes(i.status)).length);
    setStat('won', items.filter((i) => i.status === 'won').length);
    const c = $('#count-saved'); if (c) c.textContent = items.length || '';
  }

  function renderFilters(items) {
    const box = $('#saved-filters');
    if (!box) return;
    const count = (f) => f === 'all' ? items.length : f === 'active' ? items.filter((i) => ['watching', 'applying'].includes(i.status || 'watching')).length : items.filter((i) => i.status === f).length;
    const defs = [['all', 'All'], ['active', 'Active'], ['submitted', 'Submitted'], ['won', 'Won'], ['lost', 'Lost']];
    box.innerHTML = defs.map(([k, l]) => `<button type="button" class="chip" data-filter="${k}" aria-pressed="${activeFilter === k}">${l}<i>${count(k)}</i></button>`).join('');
    box.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { activeFilter = b.dataset.filter; applyFilter(); renderFilters(items); }));
  }

  function applyFilter() {
    document.querySelectorAll('#saved-list .tcard').forEach((el) => {
      const st = el.dataset.status;
      el.hidden = !(activeFilter === 'all' || (activeFilter === 'active' ? ['watching', 'applying'].includes(st) : st === activeFilter));
    });
    const any = [...document.querySelectorAll('#saved-list .tcard')].some((e) => !e.hidden);
    let note = document.getElementById('filter-empty');
    if (!any && savedItems.length) {
      if (!note) { note = document.createElement('p'); note.id = 'filter-empty'; note.className = 'muted'; note.style.padding = '1rem 0'; $('#saved-list').appendChild(note); }
      note.textContent = 'Nothing here yet.';
    } else if (note) note.remove();
  }

  async function loadSaved() {
    const listEl = $('#saved-list');
    const deadEl = $('#deadlines');
    try {
      const data = await MWAuth.api('/api/account/saved');
      const items = data.items || [];
      savedItems = items;
      await loadEdits();
      renderStats(items);
      if (!items.length) {
        $('#saved-filters').innerHTML = '';
        listEl.innerHTML = '<div class="empty"><h3>No saved tenders yet</h3><p>Find a tender you like and tap <b>Save to dashboard</b>. It will show up here with its documents and deadline.</p><a class="btn" href="tenders.html">Browse open tenders</a></div>';
        deadEl.innerHTML = '<p class="muted">No upcoming deadlines.</p>';
        return;
      }
      renderFilters(items);
      listEl.innerHTML = '';
      items.forEach((item) => {
        const st = STATUSES.includes(item.status) ? item.status : 'watching';
        const due = dueInfo(item.closing_date);
        const nDocs = Array.isArray(item.documents) ? item.documents.length : 0;
        const el = document.createElement('article');
        el.className = 'tcard';
        el.dataset.status = st;
        el.innerHTML = `
          <div class="tcard-top"><span class="tcard-buyer">${esc(item.buyer || 'Buyer not listed')}</span><span class="pill pill-${st}" data-pill>${cap(st)}</span></div>
          <div class="tcard-body">
            <h3 class="tcard-title">${esc(item.title || item.ocid)}</h3>
            <div class="tcard-meta">
              ${item.province ? `<span class="meta-chip prov">${esc(item.province)}</span>` : ''}
              ${item.ref_no ? `<span class="meta-chip">Ref ${esc(item.ref_no)}</span>` : ''}
              <span class="due ${due.cls}">${due.html}</span>
            </div>
            <div class="tcard-actions">
              <label class="status-field">Status
                <select data-id="${item.id}" class="status-sel" aria-label="Status">${STATUSES.map((s) => `<option value="${s}" ${st === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
              </label>
              <span class="spacer"></span>
              <button type="button" class="btn small" data-docs="${item.id}">Documents${nDocs ? ' (' + nDocs + ')' : ''}</button>
              <button type="button" class="linkish" data-share="${item.id}">Share</button>
              <button type="button" class="linkish" data-remove="${item.id}">Remove</button>
            </div>
            <div class="saved-docs" data-docs-for="${esc(item.ocid)}" hidden></div>
          </div>`;
        listEl.appendChild(el);
      });
      applyFilter();

      listEl.querySelectorAll('.status-sel').forEach((sel) => {
        sel.addEventListener('change', async () => {
          try {
            await MWAuth.api(`/api/account/saved/${sel.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ status: sel.value }) });
            const item = items.find((i) => String(i.id) === sel.dataset.id); if (item) item.status = sel.value;
            const card = sel.closest('.tcard'); card.dataset.status = sel.value;
            const pill = card.querySelector('[data-pill]'); pill.className = 'pill pill-' + sel.value; pill.textContent = cap(sel.value);
            renderStats(items); renderFilters(items); applyFilter(); renderDeadlines(items);
          } catch (e) { alert(e.message); }
        });
      });
      listEl.querySelectorAll('[data-docs]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const item = items.find((i) => String(i.id) === btn.dataset.docs);
          const box = btn.closest('.tcard').querySelector('.saved-docs');
          box.hidden = !box.hidden;
          if (!box.hidden) renderDocs(item, box);
        });
      });
      listEl.querySelectorAll('[data-remove]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Remove this saved tender?')) return;
          try {
            await MWAuth.api(`/api/account/saved/${btn.dataset.remove}`, { method: 'DELETE' });
            await loadSaved();
          } catch (e) { alert(e.message); }
        });
      });
      renderDeadlines(items);
    } catch (err) {
      listEl.innerHTML = `<p class="muted">${esc(err.message)}. If tables are missing, run the SQL files in backend/sql in Supabase.</p>`;
      deadEl.innerHTML = '';
    }
  }

  function renderDeadlines(items) {
    const deadEl = $('#deadlines');
    const upcoming = items
      .filter((i) => { const d = daysUntil(i.closing_date); return d != null && d >= 0 && d <= 14 && !['won', 'lost', 'submitted'].includes(i.status); })
      .sort((a, b) => new Date(a.closing_date) - new Date(b.closing_date))
      .slice(0, 8);
    if (!upcoming.length) { deadEl.innerHTML = '<p class="muted">Nothing closing in the next 14 days.</p>'; return; }
    deadEl.innerHTML = upcoming.map((item) => {
      const d = daysUntil(item.closing_date);
      return `<div class="dl-item ${d <= 3 ? 'urgent' : d <= 7 ? 'warn' : ''}">
        <div class="dl-days"><b>${d <= 0 ? 'Today' : d}</b><small>${d <= 0 ? '' : d === 1 ? 'day' : 'days'}</small></div>
        <div class="dl-txt"><strong>${esc(item.title || item.ocid)}</strong><span>${esc(formatDate(item.closing_date))}</span></div></div>`;
    }).join('');
  }

  // ---- tabs ----
  function showTab(name) {
    document.querySelectorAll('.dash-tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    document.querySelectorAll('.tab-pane').forEach((p) => { p.hidden = p.id !== 'tab-' + name; });
    try { history.replaceState(null, '', name === 'profile' || name === 'alerts' ? '#' + name : location.pathname + location.search); } catch (_) {}
  }
  document.querySelectorAll('.dash-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  if (location.hash === '#profile') showTab('profile');
  if (location.hash === '#alerts') showTab('alerts');
  window.addEventListener('hashchange', () => { if (location.hash === '#alerts') showTab('alerts'); else if (location.hash === '#profile') showTab('profile'); });

  function updateCompleteness() {
    const f = $('#profile-form');
    const keys = ['registered_name', 'cipc_number', 'contact_email', 'contact_phone', 'address_line1', 'city', 'province', 'postal_code', 'tax_number', 'vat_number', 'bbbee_level'];
    const done = keys.filter((k) => f[k] && String(f[k].value).trim()).length;
    const pct = Math.round((done / keys.length) * 100);
    const fill = $('#complete-fill'); fill.style.width = pct + '%'; fill.classList.toggle('done', pct === 100);
    $('#complete-text').textContent = pct + '% complete';
    const m = $('#profile-meter'); m.textContent = pct === 100 ? '✓' : pct + '%'; m.classList.toggle('done', pct === 100);
    updateNudge();
  }

  // Banner at the top of the dashboard until the basics are filled in (it is what fills tender forms for you)
  function updateNudge() {
    const f = $('#profile-form'), box = $('#profile-nudge');
    if (!f || !box) return;
    const has = (k) => !!(f[k] && String(f[k].value).trim());
    const steps = [
      ['company name', has('registered_name')], ['registration number', has('cipc_number')], ['phone number', has('contact_phone')],
      ['address', has('address_line1') && has('city')], ['company documents', cdocs.length > 0], ['signature', !!mySig],
      ['tender alerts', !!(alertPrefs && alertPrefs.enabled)],
    ];
    const missing = steps.filter((x) => !x[1]).map((x) => x[0]);
    nudgeTarget = missing.every((m) => m === 'tender alerts') ? 'alerts' : 'profile';
    $('#pn-go').textContent = nudgeTarget === 'alerts' ? 'Set up tender alerts' : 'Complete profile';
    box.hidden = missing.length === 0;
    if (!missing.length) return;
    $('#pn-text').textContent = 'It fills in your tender documents for you and saves you typing. Still to add: ' + missing.join(', ') + '.';
    $('#pn-fill').style.width = Math.round(((steps.length - missing.length) / steps.length) * 100) + '%';
  }
  let nudgeTarget = 'profile';
  $('#pn-go').addEventListener('click', () => {
    showTab(nudgeTarget);
    const t = $('#tab-' + nudgeTarget); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  async function loadProfile() {
    const form = $('#profile-form');
    try {
      const data = await MWAuth.api('/api/account/profile');
      const p = data.profile || {};
      form.registered_name.value = p.registered_name || '';
      form.trading_name.value = p.trading_name || '';
      form.cipc_number.value = p.cipc_number || '';
      form.industries.value = Array.isArray(p.industries) ? p.industries.join(', ') : '';
      form.contact_email.value = p.contact_email || data.email || '';
      form.contact_phone.value = p.contact_phone || '';
      form.address_line1.value = p.address_line1 || '';
      form.address_line2.value = p.address_line2 || '';
      form.city.value = p.city || '';
      form.province.value = p.province || '';
      form.postal_code.value = p.postal_code || '';
      form.tax_number.value = p.tax_number || '';
      form.vat_number.value = p.vat_number || '';
      form.bbbee_level.value = p.bbbee_level || '';
      form.cidb_grade.value = p.cidb_grade || '';
      form.cidb_number.value = p.cidb_number || '';
      const bank = p.banking || {};
      form.bank_name.value = bank.bank || '';
      form.bank_account.value = bank.account || '';
      form.bank_branch.value = bank.branch || '';
    } catch (err) {
      console.warn(err);
    }
    updateCompleteness();
    form.addEventListener('input', updateCompleteness);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('#profile-msg');
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      const industries = form.industries.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const body = {
        registered_name: form.registered_name.value.trim(),
        trading_name: form.trading_name.value.trim(),
        cipc_number: form.cipc_number.value.trim(),
        industries,
        contact_email: form.contact_email.value.trim(),
        contact_phone: form.contact_phone.value.trim(),
        address_line1: form.address_line1.value.trim(),
        address_line2: form.address_line2.value.trim(),
        city: form.city.value.trim(),
        province: form.province.value,
        postal_code: form.postal_code.value.trim(),
        tax_number: form.tax_number.value.trim(),
        vat_number: form.vat_number.value.trim(),
        bbbee_level: form.bbbee_level.value,
        cidb_grade: form.cidb_grade.value.trim(),
        cidb_number: form.cidb_number.value.trim(),
        banking: {
          bank: form.bank_name.value.trim(),
          account: form.bank_account.value.trim(),
          branch: form.bank_branch.value.trim(),
        },
      };
      try {
        await MWAuth.api('/api/account/profile', { method: 'PUT', body: JSON.stringify(body) });
        msg.hidden = false;
        msg.className = 'form-msg ok';
        msg.textContent = 'Profile saved ✓';
      } catch (err) {
        msg.hidden = false;
        msg.className = 'form-msg err';
        msg.textContent = err.message || 'Save failed. Ensure SQL tables exist in Supabase.';
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ===================================================================
  // Company documents (CIPC, CSD, B-BBEE, CIDB, tax clearance …)
  // ===================================================================
  const DOC_TYPES = [
    ['cipc', 'CIPC registration documents', 'Company registration certificate or CIPC disclosure'],
    ['csd', 'CSD supplier summary report', 'Central Supplier Database report'],
    ['tax', 'Tax compliance status / clearance', 'SARS tax compliance letter or TCS PIN'],
    ['bbbee', 'B-BBEE certificate or affidavit', ''],
    ['cidb', 'CIDB registration certificate', 'Construction tenders'],
    ['vat', 'VAT registration certificate', ''],
    ['coida', 'COIDA letter of good standing', 'Compensation Fund'],
    ['bank', 'Bank confirmation letter', ''],
    ['directors_id', 'Directors’ ID copies', ''],
  ];
  const MAX_UPLOAD = 8 * 1024 * 1024;
  let cdocs = [];

  const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round((n || 0) / 1024)) + ' KB');
  const daysLeft = (iso) => (iso ? Math.ceil((new Date(iso + 'T23:59:59') - new Date()) / 86400000) : null);
  function cdMsg(text, cls) { const m = $('#cdocs-msg'); m.hidden = !text; m.textContent = text || ''; m.className = 'form-msg ' + (cls || ''); }

  function fileToBase64(blobOrFile) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(new Error('Could not read that file.'));
      r.readAsDataURL(blobOrFile);
    });
  }
  // Photos of paperwork: re-encode as a sensible-size JPEG. This also bakes in the phone's rotation,
  // so the picture comes out the right way up inside the merged PDF.
  async function prepareImage(file) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.88));
    return { blob, name: file.name.replace(/\.\w+$/, '') + '.jpg' };
  }

  async function uploadCompanyDoc(type, file, label) {
    if (!file) return;
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const isImg = /^image\/(jpeg|png)$/.test(file.type) || /\.(jpe?g|png)$/i.test(file.name);
    if (!isPdf && !isImg) { cdMsg('Please choose a PDF, JPG or PNG file.', 'err'); return; }
    let blob = file, name = file.name;
    if (isImg) { try { const p = await prepareImage(file); blob = p.blob; name = p.name; } catch (_) { /* send as is */ } }
    if (blob.size > MAX_UPLOAD) { cdMsg('That file is over 8 MB. Please upload a smaller scan.', 'err'); return; }
    cdMsg('Uploading…');
    try {
      const b64 = await fileToBase64(blob);
      await MWAuth.api('/api/account/company-docs', { method: 'POST', body: JSON.stringify({ doc_type: type, label: label || null, file_name: name, file_base64: b64 }) });
      cdMsg('Uploaded ✓', 'ok');
      await loadCompanyDocs(true);
    } catch (err) { cdMsg(err.message || 'Upload failed.', 'err'); }
  }

  async function openCompanyDoc(id) {
    const w = window.open('', '_blank'); // opened first so the browser doesn't block it
    try {
      const token = await MWAuth.getAccessToken();
      const r = await fetch(MADEWELL.apiBase + '/api/account/company-docs/' + encodeURIComponent(id) + '/file', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) throw new Error('Could not open that document.');
      const url = URL.createObjectURL(await r.blob());
      if (w) w.location = url; else { const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.click(); }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) { if (w) w.close(); cdMsg(err.message, 'err'); }
  }

  function expiryBadge(iso) {
    const d = daysLeft(iso);
    if (d == null) return '';
    if (d < 0) return '<span class="cdoc-badge bad">Expired</span>';
    if (d <= 30) return '<span class="cdoc-badge warn">Expires in ' + d + (d === 1 ? ' day' : ' days') + '</span>';
    return '';
  }

  function docRow(def, doc) {
    const [type, title, hint] = def;
    const row = document.createElement('div');
    row.className = 'cdoc' + (doc ? ' has' : '');
    row.innerHTML = `
      <div class="cdoc-info">
        <strong>${esc(doc && doc.label ? doc.label : title)}</strong>
        ${doc ? `<span class="cdoc-file">✓ ${esc(doc.file_name || 'Uploaded')} · ${fmtSize(doc.size_bytes)} · ${esc(formatDate(doc.uploaded_at).split(',')[0])}</span>` : (hint ? `<small>${esc(hint)}</small>` : '<small>Not uploaded yet</small>')}
      </div>
      <div class="cdoc-act">
        ${doc ? '<button type="button" class="btn small ghost-btn" data-a="view">View</button>' : ''}
        <button type="button" class="btn small ${doc ? 'ghost-btn' : ''}" data-a="pick">${doc ? 'Replace' : 'Upload'}</button>
        ${doc ? '<button type="button" class="linkish" data-a="del">Remove</button>' : ''}
        <input type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" hidden>
      </div>
      ${doc ? `<div class="cdoc-exp"><label>Expires <input type="date" value="${esc(doc.expires_on || '')}" aria-label="Expiry date for ${esc(title)}"></label>${expiryBadge(doc.expires_on)}<small>Optional. We&rsquo;ll warn you before you attach an expired document.</small></div>` : ''}`;
    const file = row.querySelector('input[type=file]');
    row.querySelector('[data-a=pick]').addEventListener('click', () => file.click());
    file.addEventListener('change', async () => { const f = file.files[0]; file.value = ''; row.classList.add('busy'); await uploadCompanyDoc(type, f, doc && doc.label); row.classList.remove('busy'); });
    if (doc) {
      row.querySelector('[data-a=view]').addEventListener('click', () => openCompanyDoc(doc.id));
      row.querySelector('[data-a=del]').addEventListener('click', async () => {
        if (!confirm('Remove “' + (doc.label || title) + '”?')) return;
        try { await MWAuth.api('/api/account/company-docs/' + doc.id, { method: 'DELETE' }); await loadCompanyDocs(true); } catch (err) { cdMsg(err.message, 'err'); }
      });
      const exp = row.querySelector('input[type=date]');
      exp.addEventListener('change', async () => {
        try { await MWAuth.api('/api/account/company-docs/' + doc.id, { method: 'PATCH', body: JSON.stringify({ expires_on: exp.value || null }) }); cdMsg('Saved ✓', 'ok'); await loadCompanyDocs(true); }
        catch (err) { cdMsg(err.message, 'err'); }
      });
    }
    return row;
  }

  function renderCompanyDocs() {
    const box = $('#cdocs');
    box.innerHTML = '';
    DOC_TYPES.forEach((def) => box.appendChild(docRow(def, cdocs.find((d) => d.doc_type === def[0]))));
    // any number of "other" documents, each with its own name
    cdocs.filter((d) => d.doc_type === 'other').forEach((d) => box.appendChild(docRow(['other', d.label || 'Other document', ''], d)));
    const add = document.createElement('div');
    add.className = 'cdoc-other';
    add.innerHTML = `<strong>Another document</strong>
      <div class="cdoc-other-row">
        <input type="text" maxlength="80" placeholder="Name, e.g. Company profile or Reference letter" aria-label="Document name">
        <button type="button" class="btn small">Choose file &amp; upload</button>
        <input type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" hidden>
      </div>`;
    const nameIn = add.querySelector('input[type=text]'), file = add.querySelector('input[type=file]');
    add.querySelector('button').addEventListener('click', () => { if (!nameIn.value.trim()) { nameIn.focus(); cdMsg('Give the document a name first.', 'err'); return; } cdMsg(''); file.click(); });
    file.addEventListener('change', async () => { const f = file.files[0]; file.value = ''; add.classList.add('busy'); await uploadCompanyDoc('other', f, nameIn.value.trim()); add.classList.remove('busy'); });
    box.appendChild(add);
  }

  async function loadCompanyDocs(keepMsg) {
    try {
      cdocs = (await MWAuth.api('/api/account/company-docs')).items || [];
      if (!keepMsg) cdMsg('');
    } catch (err) {
      cdocs = [];
      cdMsg(err.message || 'Could not load your documents.', 'err');
    }
    renderCompanyDocs();
    updateNudge();
  }

  // ===================================================================
  // Signature
  // ===================================================================
  let mySig = null;
  function sgMsg(text, cls) { const m = $('#sig-msg'); m.hidden = !text; m.textContent = text || ''; m.className = 'form-msg ' + (cls || ''); }
  function renderSignature() {
    const pv = $('#sig-preview');
    pv.innerHTML = mySig ? `<img alt="Your signature" src="${esc(mySig.png)}">` : '<p class="muted">No signature yet.</p>';
    $('#sig-draw').textContent = mySig ? 'Draw a new one' : 'Draw signature';
    $('#sig-remove').hidden = !mySig;
    updateNudge();
  }
  async function loadSignature() {
    try { mySig = (await MWAuth.api('/api/account/signature')).signature || null; } catch (_) { mySig = null; }
    renderSignature();
  }
  $('#sig-draw').addEventListener('click', () => {
    sgMsg('');
    MWDocViewer.signaturePad({
      title: mySig ? 'Draw a new signature' : 'Draw your signature', useLabel: 'Save signature', saveToggle: false,
      onDone: async (sig) => { mySig = { png: sig.url, width: sig.w, height: sig.h }; renderSignature(); sgMsg('Signature saved ✓', 'ok'); },
    });
  });
  $('#sig-remove').addEventListener('click', async () => {
    if (!confirm('Remove your saved signature? Documents you have already signed keep theirs.')) return;
    try { await MWAuth.api('/api/account/signature', { method: 'DELETE' }); mySig = null; renderSignature(); sgMsg('Removed.', 'ok'); }
    catch (err) { sgMsg(err.message, 'err'); }
  });

  // ===================================================================
  // Tender alerts
  // ===================================================================
  const PROVINCES = ['Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo', 'Mpumalanga', 'Northern Cape', 'North West', 'Western Cape'];
  let alertPrefs = null;
  const alSel = { cats: new Set(), provs: new Set() };
  function alMsg(text, cls) { const m = $('#al-msg'); m.hidden = !text; m.textContent = text || ''; m.className = 'form-msg ' + (cls || ''); }

  function alRenderChips() {
    document.querySelectorAll('#al-cats .chip').forEach((b) => b.setAttribute('aria-pressed', String(alSel.cats.has(b.dataset.v))));
    document.querySelectorAll('#al-provs .chip').forEach((b) => b.setAttribute('aria-pressed', String(alSel.provs.has(b.dataset.v))));
  }
  function alResult(n) {
    const el = $('#al-result');
    if (n == null) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = n === 0
      ? 'No open tenders match right now. Try fewer keywords or more provinces. We will email you when new ones appear.'
      : n + (n === 1 ? ' open tender matches' : ' open tenders match') + ' right now. You will get up to 10 of them tomorrow morning, then new ones as they appear.';
  }
  function alSync() {
    const on = $('#alerts-form').enabled.checked;
    $('#al-state').textContent = on ? 'Alerts are ON' : 'Email me matching tenders';
    const m = $('#alerts-meter'); m.textContent = alertPrefs && alertPrefs.enabled ? '✓' : ''; m.classList.toggle('done', !!(alertPrefs && alertPrefs.enabled));
  }
  function alFill(prefs) {
    const f = $('#alerts-form');
    f.enabled.checked = !!prefs.enabled;
    alSel.cats = new Set(prefs.categories || []); alSel.provs = new Set(prefs.provinces || []);
    f.keywords.value = (prefs.keywords || []).join(', ');
    alRenderChips(); alSync();
  }

  (function buildAlertsUi() {
    const wrap = $('#al-provs');
    PROVINCES.forEach((p) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.dataset.v = p; b.setAttribute('aria-pressed', 'false'); b.textContent = p; wrap.appendChild(b); });
    $('#al-cats').addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (!b) return; alSel.cats.has(b.dataset.v) ? alSel.cats.delete(b.dataset.v) : alSel.cats.add(b.dataset.v); alRenderChips(); });
    wrap.addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (!b) return; alSel.provs.has(b.dataset.v) ? alSel.provs.delete(b.dataset.v) : alSel.provs.add(b.dataset.v); alRenderChips(); });
    $('#alerts-form').enabled.addEventListener('change', async (e) => {
      const sw = e.target;
      if (sw.checked && window.MWBilling) {
        let st = null; try { st = await MWBilling.status(); } catch (_) {}
        if (st && !st.pro) { sw.checked = false; alSync(); MWBilling.openPaywall({ reason: 'alerts', onUnlocked: () => { sw.checked = true; alSync(); alMsg('Pro is on. Press “Save alerts” to start getting emails.', 'ok'); } }); return; }
      }
      alSync();
    });
    $('#al-use-ind').addEventListener('click', () => { const v = $('#profile-form').industries.value.trim(); if (v) $('#alerts-form').keywords.value = v; else alMsg('Add your industries in the Company profile first.', 'err'); });

    $('#alerts-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target, btn = f.querySelector('button[type=submit]');
      btn.disabled = true; alMsg('Saving…');
      try {
        const r = await MWAuth.api('/api/account/alerts', { method: 'PUT', body: JSON.stringify({ enabled: f.enabled.checked, categories: [...alSel.cats], provinces: [...alSel.provs], keywords: f.keywords.value }) });
        alertPrefs = r.prefs; alFill(r.prefs); alResult(r.matches); updateNudge();
        alMsg(r.prefs.enabled ? 'Saved. Alerts are on ✓' : 'Saved. Alerts are off.', 'ok');
      } catch (err) { if (proGate(err)) { alMsg(''); f.enabled.checked = false; alSync(); } else alMsg(err.message || 'Could not save.', 'err'); }
      finally { btn.disabled = false; }
    });
    $('#al-test').addEventListener('click', async (e) => {
      const btn = e.target; btn.disabled = true; alMsg('Sending…');
      try {
        const r = await MWAuth.api('/api/account/alerts/test', { method: 'POST', body: '{}' });
        alMsg(r.sent ? 'Test email sent to ' + (currentUser && currentUser.email) + '. Check your inbox (and spam).' : (r.message || 'Nothing to send.'), r.sent ? 'ok' : 'err');
      } catch (err) { if (proGate(err)) alMsg(''); else alMsg(err.message || 'Could not send the test email.', 'err'); }
      finally { btn.disabled = false; }
    });
  })();

  async function loadAlerts() {
    $('#al-email').textContent = currentUser && currentUser.email ? 'Alerts are sent to ' + currentUser.email + '.' : '';
    try {
      const r = await MWAuth.api('/api/account/alerts');
      alertPrefs = r.prefs; alFill(r.prefs); alResult(r.enabled === false ? null : r.matches);
      // first time here: suggest the industries from the company profile as keywords
      if (!(r.prefs.keywords || []).length && !r.prefs.enabled) { const ind = $('#profile-form').industries.value.trim(); if (ind) $('#alerts-form').keywords.value = ind; }
      if (!r.prefs.enabled && !(r.prefs.categories || []).length && !(r.prefs.keywords || []).length) alResult(null);
    } catch (err) { alMsg(err.message || '', 'err'); }
    updateNudge();
  }

  init();
})();
