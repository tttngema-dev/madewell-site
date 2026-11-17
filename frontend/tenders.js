(function () {
  const cfg = window.MADEWELL || {};
  const API_BASE = cfg.apiBase || 'http://localhost:4000';
  const $ = (s) => document.querySelector(s);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    page: 1, pageSize: 20, total: 0, q: '', status: 'all', category: '', sort: 'closing', items: [],
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
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
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
        ? 'No tenders matched your filters in the current window.'
        : 'Showing ' + state.items.length + ' of ' + data.total + ' tenders · published ' + data.dateFrom + ' – ' + data.dateTo;
      if (data.partial && data.total > 0) {
        metaText += ' · some National Treasury ranges were unavailable';
      }
      meta.textContent = metaText;
      renderPager();
    } catch (err) {
      const msg = err.name === 'AbortError'
        ? 'Tenders are taking too long to load. The National Treasury feed may be slow — please try again in a minute.'
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
      const catBadge = t.category ? '<span class="badge cat">' + esc(t.category) + '</span>' : '';
      const val = formatValue(t.valueZar, t.currency);
      const closeCls = closingClass(t.closingDate);
      const desc = truncate(t.description, 180);
      const province = t.province ? esc(t.province) : '';
      btn.innerHTML =
        '<div class="row-top"><span class="ref">' + esc(t.id || t.ocid) + '</span><span class="badges">' + newBadge + statusBadge + catBadge + '</span></div>' +
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

  async function openDetail(t) {
    const body = $('#detail-body');
    const val = formatValue(t.valueZar, t.currency);
    const docs = !(t.documents || []).length
      ? '<p class="fine">No documents listed in this release.</p>'
      : '<ul class="docs">' + (t.documents || []).map((d) =>
          '<li><a href="' + esc(d.url) + '" target="_blank" rel="noopener">' + esc(d.title) + (d.format ? ' · ' + esc(d.format) : '') + '</a></li>'
        ).join('') + '</ul>';

    body.innerHTML =
      '<p class="eyebrow" style="color:var(--gold);font-size:.8rem;margin:0 0 .4rem">' + esc(t.id || '') + '</p>' +
      '<h2 id="detail-title">' + esc(t.title) + '</h2>' +
      '<p class="d-buyer">' + esc(t.buyer || '') + '</p>' +
      '<div class="d-grid">' +
      '<div><span class="lab">Status</span><span>' + esc(t.status === 'closed' ? 'Closed' : 'Open') + '</span></div>' +
      '<div><span class="lab">Category</span><span>' + esc(t.category || '—') + '</span></div>' +
      '<div><span class="lab">Province</span><span>' + esc(t.province || '—') + '</span></div>' +
      '<div><span class="lab">Method</span><span>' + esc(t.method || '—') + '</span></div>' +
      '<div><span class="lab">Published</span><span>' + esc(formatDate(t.published)) + '</span></div>' +
      '<div><span class="lab">Closes</span><span>' + esc(formatDate(t.closingDate)) + ' · ' + esc(closingLabel(t.closingDate)) + '</span></div>' +
      (val ? '<div><span class="lab">Value</span><span>' + esc(val) + '</span></div>' : '') +
      '</div>' +
      '<h3 style="font-size:1.05rem;margin-top:1.25rem">Description</h3>' +
      '<div class="desc">' + esc(t.description || 'No description provided.') + '</div>' +
      '<h3 style="font-size:1.05rem">Documents</h3>' + docs +
      '<div class="actions">' +
      '<a class="btn" href="https://www.etenders.gov.za/" target="_blank" rel="noopener">Open eTenders portal</a>' +
      '<button type="button" class="btn ghost" id="btn-save">Save to dashboard</button>' +
      '</div>' +
      '<p class="fine" style="margin-top:1.25rem">Always download the official pack and confirm closing time on the National Treasury portal before you prepare a bid.</p>';

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
  ['status', 'category', 'sort'].forEach((id) => {
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
  state.sort = $('#sort').value;
  if (window.MWAuth) MWAuth.hydrateNav();
  load();
})();
