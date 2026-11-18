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
        ? 'First load is building a tender cache from National Treasury. Wait a few seconds and tap Try again — later loads are instant.'
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
      const newBadge = t.isNew ? '<span class="badge new">New</span>' : '';
      const provBadge = t.province ? '<span class="badge prov">' + esc(t.province) + '</span>' : '';
      const brief = t.briefing && t.briefing.required === true
        ? '<span class="badge brief">' + (t.briefing.compulsory ? 'Compulsory briefing' : 'Briefing') + '</span>' : '';
      const catBadge = t.category ? '<span class="badge cat">' + esc(t.category) + '</span>' : '';
      const val = formatValue(t.valueZar, t.currency);
      const closeCls = closingClass(t.closingDate);
      const desc = truncate(t.description, 180);
      const province = '';
      btn.innerHTML =
        '<div class="row-top"><span class="ref">' + esc(t.id || t.ocid) + '</span><span class="badges">' + newBadge + statusBadge + provBadge + brief + catBadge + '</span></div>' +
        '<h3>' + esc(t.title) + '</h3>' +
        (desc ? '<p class="card-desc">' + esc(desc) + '</p>' : '') +
        '<p class="buyer">' + esc(t.buyer || 'Buyer not listed') + (province ? ' · <span class="province">' + province + '</span>' : '') + '</p>' +
        '<div class="meta-line">' +
        '<span class="closing ' + closeCls + '"><strong>' + esc(closingLabel(t.closingDate)) + '</strong> · ' + esc(formatDate(t.closingDate)) + '</span>' +
        (val ? '<span>Est. ' + esc(val) + '</span>' : '') +
        (t.documentCount ? '<span>' + t.documentCount + ' document' + (t.documentCount === 1 ? '' : 's') + '</span>' : '') +
        '</div>';
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

  function renderDocsTab(t) {
    const docs = t.documents || [];
    if (!docs.length) {
      return '<p class="fine">No documents are attached to this tender in the data feed. Check the official portal — the bid pack may be published there.</p>';
    }
    return '<ul class="docs">' + docs.map((d) =>
      '<li><a href="' + esc(d.url) + '" target="_blank" rel="noopener"><strong>' + esc(d.title) + '</strong>' +
      '<span class="doc-meta">' + [d.format, d.datePublished ? formatDay(d.datePublished) : ''].filter(Boolean).map(esc).join(' · ') + '</span></a></li>'
    ).join('') + '</ul>';
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
      '<div class="actions">' +
      '<a class="btn" href="' + esc(t.sourceUrl || 'https://www.etenders.gov.za/') + '" target="_blank" rel="noopener">Open on eTenders portal</a>' +
      '<a class="btn ghost" href="https://data.etenders.gov.za/" target="_blank" rel="noopener">About the data</a>' +
      '</div>' +
      '<p class="fine" style="margin-top:1.25rem">Always download the official pack and confirm the closing time on the National Treasury portal before you prepare a bid.</p>'
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

    $('#detail').hidden = false;
    $('#detail-backdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    $('#detail-close').focus();

    const saveBtn = $('#btn-save');
    const user = window.MWAuth ? await MWAuth.getUser() : null;
    if (!user) {
      saveBtn.textContent = 'Sign in to save';
      saveBtn.addEventListener('click', () => {
        location.href = 'login.html?next=' + encodeURIComponent(location.pathname);
      });
    } else {
      try {
        const check = await MWAuth.api('/api/account/saved/ocid/' + encodeURIComponent(t.ocid));
        if (check.saved) { saveBtn.textContent = 'Saved ✓'; saveBtn.disabled = true; }
      } catch (_) {}
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        try {
          await MWAuth.api('/api/account/saved', {
            method: 'POST',
            body: JSON.stringify({
              ocid: t.ocid, title: t.title, buyer: t.buyer, closing_date: t.closingDate, status: 'watching',
            }),
          });
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
    if (e.key === 'Escape' && !$('#detail').hidden) closeDetail();
  });

  state.status = $('#status').value;
  state.category = $('#category').value;
  state.province = $('#province').value;
  state.sort = $('#sort').value;
  if (window.MWAuth) MWAuth.hydrateNav();
  load();
})();
