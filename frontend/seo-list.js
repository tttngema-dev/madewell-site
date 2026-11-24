/* Live "latest open tenders" list used on the province and category pages. Links go to the shareable tender pages (/tender/...). */
(function () {
  var el = document.querySelector('[data-live]');
  if (!el) return;
  var cnt = document.getElementById('live-count'), cfg = window.MADEWELL || {};
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  // keep identical to slugify() in worker/index.js
  function slug(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70).replace(/-+$/, ''); }
  function path(t) { return '/tender/' + (slug(t.title) || 'tender') + '--' + encodeURIComponent(t.ocid); }
  function closes(iso) {
    if (!iso) return 'No closing date';
    var d = Math.ceil((new Date(iso) - new Date()) / 86400000);
    return d < 0 ? 'Closed' : d === 0 ? 'Closes today' : d === 1 ? 'Closes tomorrow' : 'Closes in ' + d + ' days';
  }
  var ctl = window.AbortController ? new AbortController() : null;
  var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 20000);
  fetch((cfg.apiBase || '') + '/api/tenders?status=open&sort=newest&pageSize=10&' + el.getAttribute('data-live'), ctl ? { signal: ctl.signal } : {})
    .then(function (r) { return r.json(); })
    .then(function (j) {
      clearTimeout(timer);
      if (!j || !j.ok) throw new Error('none');
      if (!j.items || !j.items.length) { if (cnt) cnt.textContent = 'No open tenders match right now. New ones are added every day.'; el.innerHTML = ''; return; }
      if (cnt) cnt.textContent = (j.openCount ? j.openCount.toLocaleString('en-ZA') + ' open tender' + (j.openCount === 1 ? '' : 's') + ' right now. The latest:' : 'The latest open tenders:');
      el.innerHTML = j.items.map(function (t) {
        return '<a class="t-prev" href="' + path(t) + '"><strong>' + esc(t.title || t.ocid) + '</strong><span>' + esc(t.buyer || 'Buyer not listed') + (t.province ? ' · ' + esc(t.province) : '') + '</span><span class="closes">' + esc(closes(t.closingDate)) + '</span></a>';
      }).join('');
    })
    .catch(function () { clearTimeout(timer); if (cnt) cnt.textContent = 'The live list is loading slowly. Open the full tenders page to see what is open now.'; el.innerHTML = ''; });
})();
