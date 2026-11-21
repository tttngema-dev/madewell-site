(function () {
  const cfg = window.MADEWELL || {};
  const API_BASE = cfg.apiBase || 'http://localhost:4000';
  const $ = (s) => document.querySelector(s);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    page: 1, pageSize: 20, total: 0, q: '', status: 'all', category: '', province: '', sort: 'recommended', items: [],
    tab: 'details',
  };

  function daysUntil(iso) {
    if (!iso) return null;
    return Math.ceil((new Date(iso) - new Date()) / 86400000);
  }
  function formatDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('en-ZA', {
        day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch { return iso; }
  }
  function formatDay(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch { return iso; }
  }
  function briefingText(b) {
    if (!b || b.required == null) return { label: 'Not stated', cls: 'unknown' };
    if (b.required === false) return { label: 'No', cls: 'no' };
    if (b.compulsory === true) return { label: 'Yes — compulsory', cls: 'yes' };
    if (b.compulsory === false) return { label: 'Yes — not compulsory', cls: 'yes' };
    return { label: 'Yes', cls: 'yes' };
  }
  function newAgo(iso) {
    const h = Math.max(0, Math.round((Date.now() - new Date(iso)) / 3600000));
    if (h < 1) return 'just in';
    if (h < 24) return h + 'h ago';
    const d = Math.floor(h / 24);
    return d + 'd ago';
  }
  function formatValue(n, currency) {
    if (n == null || n === 0) return null;
    try {
      return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: currency || 'ZAR', maximumFractionDigits: 0 }).format(n);
    } catch { return 'R' + n.toLocaleString('en-ZA'); }
  }
  function closingClass(iso) {
    const d = daysUntil(iso);
    if (d == null || d < 0) return '';
    if (d <= 3) return 'urgent';
    if (d <= 10) return 'soon';
    return '';
  }
  function closingLabel(iso) {
    const d = daysUntil(iso);
    if (d == null) return 'No closing date';
    if (d < 0) return 'Closed';
    if (d === 0) return 'Closes today';
    if (d === 1) return 'Closes tomorrow';
    return 'Closes in ' + d + ' days';
  }

  async function load() {
    const results = $('#results');
    const meta = $('#meta');
    results.innerHTML = '<p class="loading">Loading tenders…</p>';
    meta.textContent = '';
    const params = new URLSearchParams({
      page: String(state.page), pageSize: String(state.pageSize), status: state.status, sort: state.sort,
    });
    if (state.q) params.set('q', state.q);
    if (state.category) params.set('category', state.category);
    if (state.province) params.set('province', state.province);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 35000);
      let res;
      try {
        res = await fetch(API_BASE + '/api/tenders?' + params, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Request failed');
      state.total = data.total;
      state.items = data.items || [];
      renderList();
      let metaText = data.total === 0
        ? 'No tenders matched your filters.'
        : 'Showing ' + state.items.length + ' of ' + data.total + ' tenders · ' + data.openCount + ' open';
      if (data.newestPublished) metaText += ' · latest published ' + formatDay(data.newestPublished);
      if (data.partial && data.total > 0) metaText += ' · cache still growing — refresh shortly for more';
      meta.textContent = metaText;
      renderPager();
    } catch (err) {
      const msg = err.name === 'AbortError'
        ? 'The tender list is warming up. Wait a few seconds and tap Try again — later loads are instant.'
        : (err.message || 'Could not load tenders.');
      results.innerHTML = '<p class="error">' + esc(msg) + '</p><p class="fine" style="text-align:center"><button type="button" class="btn small" id="retry-tenders">Try again</button></p>';
      meta.textContent = '';
      $('#pager').hidden = true;
      const retry = document.getElementById('retry-tenders');
      if (retry) retry.addEventListener('click', () => load());
    }
  }

  function truncate(s, n) {
    s = String(s || '').trim();
    if (!s) return '';
    if (s.length <= n) return s;
    return s.slice(0, n).replace(/\s+\S*$/, '') + '…';
  }

  function renderList() {
    const results = $('#results');
    if (!state.items.length) {
      results.innerHTML = '<p class="empty">No tenders found. Try “All” status, clear the search, or a broader keyword.</p>';
      return;
    }
    results.innerHTML = '';
    state.items.forEach((t) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tender-card';
      const statusBadge = t.status === 'closed' ? '<span class="badge closed">Closed</span>' : '<span class="badge open">Open</span>';
      const stamp = t.isNew ? '<span class="stamp-new" aria-label="New tender"><b>NEW</b><i>' + esc(newAgo(t.published)) + '</i></span>' : '';
      const provBadge = t.province ? '<span class="badge prov">' + esc(t.province) + '</span>' : '';
      const brief = t.briefing && t.briefing.required === true
        ? '<span class="badge brief">' + (t.briefing.compulsory ? 'Compulsory briefing' : 'Briefing') + '</span>' : '';
      const catBadge = t.category ? '<span class="badge cat">' + esc(t.category) + '</span>' : '';
      const val = formatValue(t.valueZar, t.currency);
      const closeCls = closingClass(t.closingDate);
      const desc = truncate(t.description, 180);
      btn.classList.toggle('is-new', !!t.isNew);
      btn.classList.toggle('is-closed', t.status === 'closed');
      btn.innerHTML =
        stamp +
        '<div class="buyer-head"><span class="buyer-name">' + esc(t.buyer || 'Buyer not listed') + '</span>' + statusBadge + '</div>' +
        '<div class="card-body">' +
        '<h3>' + esc(t.title) + '</h3>' +
        (desc ? '<p class="card-desc">' + esc(desc) + '</p>' : '') +
        '<div class="chips">' + provBadge + brief + catBadge + '</div>' +
        '<div class="meta-line">' +
        '<span class="closing ' + closeCls + '"><strong>' + esc(closingLabel(t.closingDate)) + '</strong> · ' + esc(formatDate(t.closingDate)) + '</span>' +
        '<span class="ref">Ref: ' + esc(t.id || t.ocid) + '</span>' +
        (val ? '<span>Est. ' + esc(val) + '</span>' : '') +
        (t.documentCount ? '<span>' + t.documentCount + ' document' + (t.documentCount === 1 ? '' : 's') + '</span>' : '') +
        '</div></div>';
      btn.addEventListener('click', () => openDetail(t));
      results.appendChild(btn);
    });
  }

  function renderPager() {
    const pager = $('#pager');
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    if (totalPages <= 1) { pager.hidden = true; return; }
    pager.hidden = false;
    $('#page-label').textContent = 'Page ' + state.page + ' of ' + totalPages;
    $('#prev').disabled = state.page <= 1;
    $('#next').disabled = state.page >= totalPages;
  }

  function field(label, valueHtml) {
    return '<div><span class="lab">' + label + '</span><span>' + valueHtml + '</span></div>';
  }

  function renderDetailsTab(t) {
    const val = formatValue(t.valueZar, t.currency);
    const b = briefingText(t.briefing);
    const bd = t.briefing || {};
    const open = t.status !== 'closed';
    let briefExtra = '';
    if (bd.date) briefExtra += '<div class="brief-extra"><span class="lab">Briefing date</span><span>' + esc(formatDate(bd.date)) + '</span></div>';
    if (bd.venue) briefExtra += '<div class="brief-extra"><span class="lab">Venue</span><span>' + esc(bd.venue) + '</span></div>';
    if (bd.notes) briefExtra += '<div class="brief-extra"><span class="lab">Notes</span><span>' + esc(bd.notes) + '</span></div>';
    const c = t.contact;
    const contact = c
      ? '<h3 class="d-h">Contact</h3><div class="d-grid">' +
        (c.name ? field('Name', esc(c.name)) : '') +
        (c.email ? field('Email', '<a href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a>') : '') +
        (c.phone ? field('Phone', esc(c.phone)) : '') + '</div>'
      : '';
    return (
      '<div class="d-grid">' +
      field('Status', '<span class="badge ' + (open ? 'open' : 'closed') + '">' + (open ? 'Open' : 'Closed') + '</span>') +
      field('Province', t.province ? '<span class="badge prov">' + esc(t.province) + '</span>' : '—') +
      field('Briefing session', '<span class="brief-val ' + b.cls + '">' + esc(b.label) + '</span>') +
      briefExtra +
      field('Closes', esc(formatDate(t.closingDate)) + ' · ' + esc(closingLabel(t.closingDate))) +
      field('Published', esc(formatDate(t.published))) +
      field('Category', esc(t.category || '—')) +
      field('Method', esc(t.method || '—')) +
      (val ? field('Est. value', esc(val)) : '') +
      '</div>' +
      '<h3 class="d-h">Description</h3>' +
      '<div class="desc">' + esc(t.description || 'No description provided.') + '</div>' +
      contact
    );
  }

  // Word / Excel / zip files can't be shown in the browser, so those keep a plain download link.
  function canPreview(d) {
    const s = ((d.format || '') + ' ' + (d.url || '') + ' ' + (d.title || '')).toLowerCase();
    if (/\.(docx?|xlsx?|pptx?|zip|rar|7z|csv|txt|rtf)(\b|$|\?)/.test(s)) return false;
    if (/(msword|wordprocessing|spreadsheet|ms-excel|powerpoint|zip|rar)/.test(s)) return false;
    return !!d.url;
  }

  function renderDocsTab(t) {
    const docs = t.documents || [];
    if (!docs.length) {
      return '<p class="fine">No documents are attached to this tender in the data feed. Check the official portal — the bid pack may be published there.</p>';
    }
    return '<p class="fine docs-hint"><span class="tag-free" style="margin:0 .3rem 0 0">Free</span> Preview any document here. Your first download is free. <span class="tag-pro" style="margin:0 .3rem 0 .2rem">Pro</span> After that, <a href="pricing.html">Pro</a> unlocks unlimited downloads, fill-in, stamp, signature and email.</p>' +
      '<ul class="docs">' + docs.map((d, i) => {
        const meta = [d.format, d.datePublished ? formatDay(d.datePublished) : ''].filter(Boolean).map(esc).join(' · ');
        const inner = '<strong>' + esc(d.title) + '</strong><span class="doc-meta">' + meta + '</span>';
        return canPreview(d)
          ? '<li class="doc-row"><button type="button" class="doc-open" data-doc="' + i + '">' + inner +
            '<span class="doc-cta">Preview</span></button></li>'
          : '<li class="doc-row"><a class="doc-open" data-dl="' + i + '" href="' + esc(d.url) + '" target="_blank" rel="noopener">' + inner +
            '<span class="doc-cta">Download</span></a></li>';
      }).join('') + '</ul>';
  }

  const savePayload = (t) => ({
    ocid: t.ocid, title: t.title, buyer: t.buyer, closing_date: t.closingDate, status: 'watching',
    documents: (t.documents || []).map((d) => ({ id: d.id, title: d.title, url: d.url, format: d.format, datePublished: d.datePublished })),
  });
  async function saveTender(t) {
    return MWAuth.api('/api/account/saved', { method: 'POST', body: JSON.stringify(savePayload(t)) });
  }
  // Not signed in yet: remember what they wanted, so after sign-in / registering they land on the dashboard with it done.
  const goSignIn = (action, t, doc) => { MWAuth.setPending({ type: action, tender: savePayload(t), doc: doc }); if (window.MWLoader) MWLoader.show('Taking you to sign in…'); location.href = 'login.html?next=dashboard.html'; };

  async function openPreview(t, idx) {
    const d = (t.documents || [])[idx];
    if (!d || !window.MWDocViewer) return;
    let signedIn = false;
    try { signedIn = !!(window.MWAuth && await MWAuth.getUser()); } catch (_) {}
    MWDocViewer.open({
      url: d.url, title: d.title, tenderTitle: t.title, ocid: t.ocid, editable: false,
      fillLabel: 'Fill in document',
      guestHint: signedIn ? null : { loginUrl: 'login.html?next=dashboard.html', signupUrl: 'signup.html?next=dashboard.html', onGo: () => MWAuth.setPending({ type: 'fill', tender: savePayload(t), doc: idx }) },
      onFill: async (btn) => {
        const user = window.MWAuth ? await MWAuth.getUser() : null;
        if (!user) { goSignIn('fill', t, idx); return; }
        btn.disabled = true; btn.textContent = 'Opening…';
        if (window.MWLoader) MWLoader.show('Opening your document…');
        try {
          await saveTender(t);
          location.href = 'dashboard.html?open=' + encodeURIComponent(t.ocid) + '&doc=' + idx;
        } catch (err) {
          if (window.MWLoader) MWLoader.hide();
          btn.disabled = false; btn.innerHTML = '<span class="dv-l">Fill in document</span><span class="dv-s">Fill in</span>';
          alert(err.message || 'Could not save this tender.');
        }
      },
    });
  }

  function renderSourceTab(t) {
    return (
      '<div class="d-grid">' +
      field('Source', 'National Treasury eTenders (OCDS open data)') +
      field('Tender number', esc(t.id || '—')) +
      field('OCID', '<code>' + esc(t.ocid) + '</code>') +
      field('Issued by', esc(t.buyer || '—')) +
      field('Last updated', esc(formatDate(t.published))) +
      field('Licence', 'Open Data Commons PDDL') +
      '</div>' +
      '<p class="fine" style="margin-top:1.25rem">Always confirm the closing time and the official bid pack before you prepare a bid.</p>'
    );
  }

  function renderTab(t, tab) {
    state.tab = tab;
    document.querySelectorAll('#detail .tab').forEach((el) => {
      const on = el.dataset.tab === tab;
      el.classList.toggle('on', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
      el.tabIndex = on ? 0 : -1;
    });
    const panel = $('#tab-panel');
    panel.innerHTML = tab === 'documents' ? renderDocsTab(t) : tab === 'source' ? renderSourceTab(t) : renderDetailsTab(t);
    if (tab === 'documents') {
      panel.querySelectorAll('button.doc-open').forEach((b) => b.addEventListener('click', () => openPreview(t, +b.dataset.doc)));
      panel.querySelectorAll('a.doc-open[data-dl]').forEach((a) => a.addEventListener('click', async (e) => {
        if (!window.MWBilling) return;
        e.preventDefault();
        const d = (t.documents || [])[+a.dataset.dl];
        if (!d || !(await MWBilling.allowDownload(t.ocid, d.url, d.title))) return; // free plan: one download
        const go = document.createElement('a'); go.href = d.url; go.target = '_blank'; go.rel = 'noopener'; document.body.appendChild(go); go.click(); go.remove();
      }));
    }
  }

  async function openDetail(t) {
    const body = $('#detail-body');
    const nDocs = (t.documents || []).length;
    body.innerHTML =
      '<p class="eyebrow" style="color:var(--gold);font-size:.8rem;margin:0 0 .4rem">' + esc(t.id || '') + '</p>' +
      '<h2 id="detail-title">' + esc(t.title) + '</h2>' +
      '<p class="d-buyer">' + esc(t.buyer || '') + '</p>' +
      '<div class="tabs" role="tablist" aria-label="Tender sections">' +
      '<button type="button" class="tab on" role="tab" data-tab="details" aria-selected="true">Details</button>' +
      '<button type="button" class="tab" role="tab" data-tab="documents" aria-selected="false" tabindex="-1">Documents' + (nDocs ? ' <span class="count">' + nDocs + '</span>' : '') + '</button>' +
      '<button type="button" class="tab" role="tab" data-tab="source" aria-selected="false" tabindex="-1">Source</button>' +
      '</div>' +
      '<div id="tab-panel" class="tab-panel" role="tabpanel"></div>' +
      '<div class="actions save-row"><button type="button" class="btn ghost" id="btn-save">Save to dashboard</button></div>';
    body.querySelectorAll('.tab').forEach((el) => el.addEventListener('click', () => renderTab(t, el.dataset.tab)));
    renderTab(t, 'details'); // Details is always the default tab

    const shareBtn = $('#detail-share');
    if (shareBtn) shareBtn.onclick = () => window.MWShare && MWShare.tender(t, shareBtn);
    $('#detail').hidden = false;
    $('#detail-backdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    $('#detail-close').focus();

    const saveBtn = $('#btn-save');
    const user = window.MWAuth ? await MWAuth.getUser() : null;
    if (!user) {
      saveBtn.textContent = 'Sign in to save';
      saveBtn.addEventListener('click', () => goSignIn('save', t));
    } else {
      try {
        const check = await MWAuth.api('/api/account/saved/ocid/' + encodeURIComponent(t.ocid));
        if (check.saved) { saveBtn.textContent = 'Saved ✓'; saveBtn.disabled = true; }
      } catch (_) {}
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        try {
          await saveTender(t);
          saveBtn.textContent = 'Saved ✓';
        } catch (err) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save to dashboard';
          alert(err.message || 'Could not save. Run the SQL migration in Supabase if tables are missing.');
        }
      });
    }
  }

  function closeDetail() {
    $('#detail').hidden = true;
    $('#detail-backdrop').hidden = true;
    document.body.style.overflow = '';
  }

  let searchTimer = null;
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (searchTimer) clearTimeout(searchTimer);
    state.q = $('#q').value.trim();
    state.page = 1;
    load();
  });
  $('#q').addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const next = $('#q').value.trim();
      if (next === state.q) return;
      state.q = next;
      state.page = 1;
      load();
    }, 350);
  });
  ['status', 'category', 'province', 'sort'].forEach((id) => {
    $('#' + id).addEventListener('change', () => {
      state[id] = $('#' + id).value;
      state.page = 1;
      load();
    });
  });
  $('#prev').addEventListener('click', () => {
    if (state.page > 1) { state.page -= 1; load(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  });
  $('#next').addEventListener('click', () => {
    const totalPages = Math.ceil(state.total / state.pageSize);
    if (state.page < totalPages) { state.page += 1; load(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  });
  $('#detail-close').addEventListener('click', closeDetail);
  $('#detail-backdrop').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#detail').hidden && !document.querySelector('.dv')) closeDetail();
  });

  state.status = $('#status').value;
  state.category = $('#category').value;
  state.province = $('#province').value;
  state.sort = $('#sort').value;
  const fToggle = $('#filters-toggle'), fRow = $('#filters-row');
  if (fToggle) fToggle.addEventListener('click', () => { const on = fRow.classList.toggle('open'); fToggle.setAttribute('aria-expanded', String(on)); });
  const urlQ = new URLSearchParams(location.search).get('q'); // from the homepage search box
  if (urlQ && urlQ.trim()) { state.q = urlQ.trim().slice(0, 120); $('#q').value = state.q; }
  if (window.MWAuth) MWAuth.hydrateNav();
  load();
  // links in alert emails open one tender directly: tenders.html?ocid=...
  const deep = new URLSearchParams(location.search).get('ocid');
  if (deep) {
    fetch(API_BASE + '/api/tenders/' + encodeURIComponent(deep)).then((r) => r.json()).then((j) => { if (j && j.item) openDetail(j.item); }).catch(() => {});
  }
})();
