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

  async function loadSaved() {
    const listEl = $('#saved-list');
    const deadEl = $('#deadlines');
    try {
      const data = await MWAuth.api('/api/account/saved');
      const items = data.items || [];
      savedItems = items;
      await loadEdits();
      if (!items.length) {
        listEl.innerHTML = '<p class="muted">No saved tenders yet. <a href="tenders.html">Browse open tenders</a> and tap Save.</p>';
        deadEl.innerHTML = '<p class="muted">No upcoming deadlines.</p>';
        return;
      }
      listEl.innerHTML = '';
      items.forEach((item) => {
        const d = daysUntil(item.closing_date);
        const div = document.createElement('div');
        div.className = 'saved-item';
        div.innerHTML = `
          <div><span class="badge-sm">${esc(item.status || 'watching')}</span></div>
          <h3>${esc(item.title || item.ocid)}</h3>
          <p class="meta">${esc(item.buyer || '')} · Closes ${esc(formatDate(item.closing_date))}${d != null && d >= 0 ? ` (${d}d)` : ''}</p>
          <div class="actions">
            <select data-id="${item.id}" class="status-sel" aria-label="Status">
              ${['watching', 'applying', 'submitted', 'won', 'lost']
                .map((s) => `<option value="${s}" ${item.status === s ? 'selected' : ''}>${s}</option>`)
                .join('')}
            </select>
            <button type="button" class="btn small" data-docs="${item.id}">Documents${Array.isArray(item.documents) && item.documents.length ? ' (' + item.documents.length + ')' : ''}</button>
            <button type="button" class="linkish" data-remove="${item.id}">Remove</button>
          </div>
          <div class="saved-docs" data-docs-for="${esc(item.ocid)}" hidden></div>`;
        listEl.appendChild(div);
      });

      listEl.querySelectorAll('.status-sel').forEach((sel) => {
        sel.addEventListener('change', async () => {
          try {
            await MWAuth.api(`/api/account/saved/${sel.dataset.id}`, {
              method: 'PATCH',
              body: JSON.stringify({ status: sel.value }),
            });
          } catch (e) {
            alert(e.message);
          }
        });
      });
      listEl.querySelectorAll('[data-docs]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const item = items.find((i) => String(i.id) === btn.dataset.docs);
          const box = btn.closest('.saved-item').querySelector('.saved-docs');
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
          } catch (e) {
            alert(e.message);
          }
        });
      });

      const upcoming = items
        .filter((i) => {
          const d = daysUntil(i.closing_date);
          return d != null && d >= 0 && d <= 14 && !['won', 'lost'].includes(i.status);
        })
        .slice(0, 8);
      if (!upcoming.length) {
        deadEl.innerHTML = '<p class="muted">Nothing closing in the next 14 days.</p>';
      } else {
        deadEl.innerHTML = '';
        upcoming.forEach((item) => {
          const d = daysUntil(item.closing_date);
          const div = document.createElement('div');
          div.className = 'deadline-item';
          div.innerHTML = `
            <h3>${esc(item.title || item.ocid)}</h3>
            <p class="meta ${d <= 3 ? 'urgent-text' : ''}">${d === 0 ? 'Closes today' : d === 1 ? 'Closes tomorrow' : `In ${d} days`} · ${esc(formatDate(item.closing_date))}</p>`;
          deadEl.appendChild(div);
        });
      }
    } catch (err) {
      listEl.innerHTML = `<p class="muted">${esc(err.message)}. If tables are missing, run backend/sql/tenders_platform.sql in Supabase.</p>`;
      deadEl.innerHTML = '';
    }
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
        msg.textContent = 'Profile saved.';
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
