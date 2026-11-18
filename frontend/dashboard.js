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
    const user = await MWAuth.requireUser('login.html');
    if (!user) return;
    await MWAuth.hydrateNav();
    const nm = (user.email || '').split('@')[0]; const hello = $('#hello-name'); if (hello && nm) hello.textContent = '';
    $('#btn-signout').addEventListener('click', async () => {
      await MWAuth.signOut();
      location.href = 'index.html';
    });
    await Promise.all([loadSaved(), loadProfile()]);
    autoOpenFromUrl();
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
    if (d && MWDocViewer.canPreview(d)) openDoc(item, d);
  }

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

  function openDoc(item, d) {
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
    docs.forEach((d) => {
      const e = editFor(item.ocid, d.url);
      const row = document.createElement('div');
      row.className = 'doc-line';
      const meta = [d.format, e ? 'Filled in · edited ' + formatDate(e.updated_at) : ''].filter(Boolean).map(esc).join(' · ');
      const can = MWDocViewer.canPreview(d);
      row.innerHTML = `<div class="doc-info"><strong>${esc(d.title)}</strong><span>${meta}</span></div>` +
        (can
          ? `<button type="button" class="btn small">${e ? 'Continue filling in' : 'Open &amp; fill in'}</button>`
          : `<a class="btn small ghost-btn" href="${esc(d.url)}" target="_blank" rel="noopener">Download</a>`);
      const b = row.querySelector('button');
      if (b) b.addEventListener('click', () => openDoc(item, d));
      box.appendChild(row);
    });
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
    try { history.replaceState(null, '', name === 'profile' ? '#profile' : location.pathname + location.search); } catch (_) {}
  }
  document.querySelectorAll('.dash-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  if (location.hash === '#profile') showTab('profile');

  function updateCompleteness() {
    const f = $('#profile-form');
    const keys = ['registered_name', 'cipc_number', 'contact_email', 'contact_phone', 'address_line1', 'city', 'province', 'postal_code', 'tax_number', 'vat_number', 'bbbee_level'];
    const done = keys.filter((k) => f[k] && String(f[k].value).trim()).length;
    const pct = Math.round((done / keys.length) * 100);
    const fill = $('#complete-fill'); fill.style.width = pct + '%'; fill.classList.toggle('done', pct === 100);
    $('#complete-text').textContent = pct + '% complete';
    const m = $('#profile-meter'); m.textContent = pct === 100 ? '✓' : pct + '%'; m.classList.toggle('done', pct === 100);
  }

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

  init();
})();
