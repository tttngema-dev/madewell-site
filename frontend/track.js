// Anonymous visit tracking: a random visitor ID, pages and form steps reached. No names, IDs or emails.
(function () {
  var API = ['localhost', '127.0.0.1'].indexOf(location.hostname) > -1 ? 'http://localhost:4000' : 'https://madewell-backend.onrender.com';
  try {
    var q = new URLSearchParams(location.search);
    if (q.get('me') === '1') localStorage.setItem('mw_internal', '1');
    if (q.get('me') === '0') localStorage.removeItem('mw_internal');
    if (localStorage.getItem('mw_internal')) { window.mwTrack = function () {}; return; }
  } catch (e) {}
  var vid;
  try { vid = localStorage.getItem('mw_vid'); if (!vid) { vid = Math.random().toString(36).slice(2, 12) + Date.now().toString(36); localStorage.setItem('mw_vid', vid); } }
  catch (e) { vid = 'anon' + Math.random().toString(36).slice(2, 10); }
  var src = 'direct';
  try {
    var p = new URLSearchParams(location.search), ref = document.referrer ? new URL(document.referrer).hostname : '', found = '';
    if (p.get('utm_source')) found = p.get('utm_source') + (p.get('utm_campaign') ? ':' + p.get('utm_campaign') : '');
    else if (p.get('fbclid')) found = 'facebook';
    else if (ref && ref !== location.hostname) found = /facebook|fb\.|instagram/.test(ref) ? 'facebook' : /whatsapp|wa\.me/.test(ref) ? 'whatsapp' : /google/.test(ref) ? 'google' : ref.slice(0, 20);
    if (found) localStorage.setItem('mw_src', found);
    src = localStorage.getItem('mw_src') || 'direct';
  } catch (e) {}
  var dev = /Mobi|Android|iPhone/i.test(navigator.userAgent) ? 'mobile' : 'desktop';
  window.mwTrack = function (e, s) {
    try { fetch(API + '/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true, body: JSON.stringify({ v: vid, e: e, s: s, p: location.pathname, src: src, dev: dev }) }).catch(function () {}); } catch (x) {}
  };
  var path = location.pathname;
  mwTrack('visit');
  if (/register/.test(path)) mwTrack('form_open');
  if (/payment-success/.test(path)) mwTrack('paid_page');
  if (/payment-cancelled/.test(path)) mwTrack('cancelled');
})();
