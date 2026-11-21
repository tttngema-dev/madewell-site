/**
 * Share a tender. The link opens tenders.html with that tender already open (details, documents, source).
 *   MWShare.tender({ ocid, title, buyer, closingDate }, anchorElement)
 * Phones: the phone's own share sheet (WhatsApp, SMS, email...). Computers: a small menu with WhatsApp, Email and Copy link.
 */
(function (g) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const linkFor = (ocid) => new URL('tenders.html?ocid=' + encodeURIComponent(ocid), location.href).href;
  let pop = null;
  function close() { if (pop) { pop.remove(); pop = null; document.removeEventListener('keydown', onKey, true); document.removeEventListener('mousedown', onDown, true); } }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
  function onDown(e) { if (pop && !pop.contains(e.target) && !e.target.closest('[data-share-anchor]')) close(); }
  function flash(msg) {
    document.querySelectorAll('.toast-soon').forEach((x) => x.remove());
    const n = document.createElement('div'); n.className = 'toast-soon'; n.setAttribute('role', 'status'); n.textContent = msg;
    document.body.appendChild(n); setTimeout(() => n.remove(), 2400);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* older browsers */ }
    try { const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); const ok = document.execCommand('copy'); t.remove(); return ok; } catch (_) { return false; }
  }
  async function tender(t, anchor) {
    if (!t || !t.ocid) return;
    const url = linkFor(t.ocid);
    let closes = '';
    try { if (t.closingDate) closes = 'Closes ' + new Date(t.closingDate).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (_) {}
    const text = ['Tender: ' + (t.title || ''), t.buyer, closes].filter(Boolean).join(' · ');
    const phone = !!(g.matchMedia && g.matchMedia('(pointer: coarse)').matches);
    if (navigator.share && phone) {
      try { await navigator.share({ title: t.title || 'Tender', text, url }); } catch (_) { /* they closed the sheet */ }
      return;
    }
    close();
    pop = document.createElement('div');
    pop.className = 'mw-share'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Share this tender');
    const msg = text + '\n' + url;
    pop.innerHTML = '<p class="mw-share-h">Share this tender</p>' +
      '<a class="mw-share-row" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent(msg) + '">WhatsApp</a>' +
      '<a class="mw-share-row" href="mailto:?subject=' + encodeURIComponent('Tender: ' + (t.title || '')) + '&body=' + encodeURIComponent(msg) + '">Email</a>' +
      '<button type="button" class="mw-share-row" data-copy>Copy link</button>' +
      '<p class="mw-share-url">' + esc(url) + '</p>';
    document.body.appendChild(pop);
    if (anchor) {
      anchor.setAttribute('data-share-anchor', '');
      const r = anchor.getBoundingClientRect();
      if (!(g.matchMedia && g.matchMedia('(max-width: 640px)').matches)) {
        pop.style.top = Math.min(r.bottom + 8, innerHeight - 220) + 'px';
        pop.style.right = Math.max(12, innerWidth - r.right) + 'px';
      }
    }
    pop.querySelector('[data-copy]').addEventListener('click', async (e) => {
      const ok = await copy(url);
      e.target.textContent = ok ? 'Link copied ✓' : 'Press and hold the link below to copy it';
      if (ok) setTimeout(close, 900);
    });
    pop.addEventListener('click', (e) => { if (e.target.closest('a')) setTimeout(close, 200); });
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
    pop.querySelector('.mw-share-row').focus();
  }
  g.MWShare = { tender, link: linkFor };
})(window);
