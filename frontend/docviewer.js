/**
 * Made Well document viewer.
 *   MWDocViewer.open({ url, title, ocid, tenderTitle, editable, onFill })
 *
 * - Preview mode (editable:false): shows the PDF in the page (pdf.js), with Download.
 * - Edit mode   (editable:true) : adds text boxes, ticks, dates, company-profile quick-fill,
 *   existing PDF form fields, autosave, Download filled PDF, and Email document.
 *
 * Libraries are vendored in /vendor and only loaded the first time a document is opened.
 */
(function (global) {
  const cfg = global.MADEWELL || {};
  const API = cfg.apiBase || 'http://localhost:4000';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const BASE = (function () {
    const cur = document.currentScript && document.currentScript.src;
    return cur ? cur.replace(/[^/]*$/, '') : new URL('./', document.baseURI).href;
  })();

  // ---------------------------------------------------------------- libraries
  let libsPromise = null;
  function loadLibs(needEditor) {
    if (!libsPromise) {
      libsPromise = import(BASE + 'vendor/pdfjs/pdf.min.mjs').then((m) => {
        m.GlobalWorkerOptions.workerSrc = BASE + 'vendor/pdfjs/pdf.worker.min.mjs';
        return m;
      });
    }
    const pdfjs = libsPromise;
    const pdflib = needEditor ? loadScript(BASE + 'vendor/pdf-lib.min.js', () => global.PDFLib) : Promise.resolve(null);
    return Promise.all([pdfjs, pdflib]).then(([a]) => a);
  }
  function loadScript(src, ready) {
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  // ---------------------------------------------------------------- helpers
  function proxied(url) { return API + '/api/doc-proxy?url=' + encodeURIComponent(url); }
  function isPdfBytes(buf) {
    const head = new Uint8Array(buf, 0, Math.min(1024, buf.byteLength));
    const s = String.fromCharCode.apply(null, head);
    return s.indexOf('%PDF-') !== -1;
  }
  function slug(s) { return String(s || 'document').replace(/\.pdf$/i, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'document'; }
  function bytesToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
  }
  function download(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function todayText() {
    return new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); // e.g. 18 November 2026
  }
  // PDF-space rectangle -> viewport-space [x1, y1, x2, y2] (works for rotated pages too)
  function viewportRect(vp, r) {
    const [ax, ay] = vp.convertToViewportPoint(r[0], r[1]);
    const [bx, by] = vp.convertToViewportPoint(r[2], r[3]);
    return [ax, ay, bx, by];
  }
  const uid = () => 'i' + Math.random().toString(36).slice(2, 9);
  function debounce(fn, ms) { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.flush = (...a) => { clearTimeout(t); fn(...a); }; return d; }

  // Wrap text to a width using a pdf-lib font (used when baking text into the PDF)
  function wrapLines(text, font, size, maxW) {
    const out = [];
    String(text).split(/\r?\n/).forEach((para) => {
      if (!para) { out.push(''); return; }
      let line = '';
      para.split(/(\s+)/).forEach((tok) => {
        const test = line + tok;
        if (!line || font.widthOfTextAtSize(test.trimEnd(), size) <= maxW) { line = test; return; }
        out.push(line.trimEnd()); line = tok.trimStart();
        // a single very long word: hard-break it
        while (font.widthOfTextAtSize(line, size) > maxW && line.length > 1) {
          let n = line.length - 1;
          while (n > 1 && font.widthOfTextAtSize(line.slice(0, n), size) > maxW) n--;
          out.push(line.slice(0, n)); line = line.slice(n);
        }
      });
      out.push(line.trimEnd());
    });
    return out;
  }
  const SUBS = { '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '✓': 'v', ' ': ' ' };
  function safeText(font, text) {
    const set = new Set(font.getCharacterSet());
    return Array.from(String(text)).map((ch) => {
      const c = SUBS[ch] || ch;
      return Array.from(c).every((x) => set.has(x.codePointAt(0)) || x === '\n') ? c : '?';
    }).join('');
  }

  // ---------------------------------------------------------------- the viewer
  function open(opts) {
    const o = Object.assign({ editable: false }, opts || {});
    const editable = !!o.editable;
    const state = {
      pdf: null, bytes: null, pages: [], zoom: 1, scale: 1,
      items: [], fields: {}, defaultSize: 11,
      tool: null, // 'text' | 'tick' | 'date' | {profile: 'value'}
      selected: null, lastFocus: null, dirty: false, user: null, profile: null,
      saveMode: 'server', closed: false,
    };
    const prevOverflow = document.body.style.overflow;

    const root = document.createElement('div');
    root.className = 'dv' + (editable ? ' dv-edit' : '');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', o.title || 'Document');
    root.innerHTML = `
      <header class="dv-bar">
        <button type="button" class="dv-btn dv-close" aria-label="Close document">&larr; <span>Close</span></button>
        <div class="dv-title"><strong>${esc(o.title || 'Document')}</strong>${o.tenderTitle ? `<span>${esc(o.tenderTitle)}</span>` : ''}</div>
        <div class="dv-zoom" role="group" aria-label="Zoom">
          <button type="button" class="dv-btn dv-ico" data-act="zoom-out" aria-label="Zoom out">−</button>
          <button type="button" class="dv-btn dv-ico" data-act="zoom-in" aria-label="Zoom in">+</button>
        </div>
        <div class="dv-actions"></div>
      </header>
      ${editable ? `<div class="dv-tools" role="toolbar" aria-label="Fill in tools">
        <button type="button" class="dv-tool" data-tool="text" title="Click on the page to type text">+ Text</button>
        <button type="button" class="dv-tool" data-tool="tick" title="Click on the page to place a tick">✓ Tick</button>
        <button type="button" class="dv-tool" data-tool="date" title="Click on the page to place today's date">Date</button>
        <button type="button" class="dv-tool" data-tool="stamp" title="Click on the page to place a company stamp">Stamp</button>
        <span class="dv-sep"></span>
        <button type="button" class="dv-btn dv-ico" data-act="size-down" aria-label="Smaller text" title="Smaller text">A−</button>
        <button type="button" class="dv-btn dv-ico" data-act="size-up" aria-label="Larger text" title="Larger text">A+</button>
        <button type="button" class="dv-btn dv-ico dv-del" data-act="delete" aria-label="Delete selected" title="Delete selected box">🗑</button>
        <span class="dv-sep"></span>
        <button type="button" class="dv-btn" data-act="profile-toggle">Company details</button>
        <span class="dv-status" role="status" aria-live="polite"></span>
      </div>` : ''}
      <div class="dv-hint" ${editable ? '' : 'hidden'}></div>
      <div class="dv-main">
        ${editable ? `<aside class="dv-profile" hidden><div class="dv-profile-head"><strong>Quick-fill from your company profile</strong><button type="button" class="dv-btn dv-ico" data-act="profile-toggle" aria-label="Close">×</button></div><p class="dv-profile-help">Tap a field on the page, then tap a value to fill it. Or tap a value, then tap anywhere on the page to drop a new box there. Only the box you’re editing stays highlighted.</p><div class="dv-chips"></div></aside>` : ''}
        <div class="dv-scroll"><div class="dv-pages"><p class="dv-loading">Loading document…</p></div></div>
      </div>
      <div class="dv-email" hidden>
        <form class="dv-email-card" novalidate>
          <h3>Email this document</h3>
          <label>Send to <input name="to" type="text" inputmode="email" autocomplete="email" placeholder="name@company.co.za (separate several with commas)" required /></label>
          <label>Subject <input name="subject" type="text" maxlength="200" /></label>
          <label>Message <textarea name="message" rows="4" maxlength="5000" placeholder="Add a short note (optional)"></textarea></label>
          <label class="dv-check"><input name="cc_me" type="checkbox" checked /> Send me a copy</label>
          <p class="dv-email-note">On supported devices, share the PDF directly with Gmail or another email app. Otherwise the PDF downloads and your email app opens.</p>
          <p class="dv-email-msg" role="status" hidden></p>
          <div class="dv-email-actions">
            <button type="button" class="dv-btn" data-act="email-cancel">Cancel</button>
            <button type="button" class="dv-btn" data-act="email-own" title="Share the PDF with an email app or open your email app">Use my email app</button>
            <button type="submit" class="dv-btn dv-primary">Send email</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(root);
    document.body.style.overflow = 'hidden';

    const $ = (s) => root.querySelector(s);
    const pagesEl = $('.dv-pages');
    const scrollEl = $('.dv-scroll');
    const actionsEl = $('.dv-actions');
    const hintEl = $('.dv-hint');
    const statusEl = $('.dv-status');

    // --- action buttons (top right)
    const btnDownload = document.createElement('button');
    btnDownload.type = 'button'; btnDownload.className = 'dv-btn'; btnDownload.dataset.act = 'download';
    btnDownload.textContent = editable ? 'Download PDF' : 'Download';
    btnDownload.disabled = true;
    actionsEl.appendChild(btnDownload);
    if (!editable && o.sourceUrl) {
      const a = document.createElement('a');
      a.className = 'dv-btn'; a.href = o.sourceUrl; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Open original';
      actionsEl.appendChild(a);
    }
    let btnEmail = null;
    if (editable) {
      btnEmail = document.createElement('button');
      btnEmail.type = 'button'; btnEmail.className = 'dv-btn dv-primary'; btnEmail.dataset.act = 'email'; btnEmail.textContent = 'Email document'; btnEmail.disabled = true;
      actionsEl.appendChild(btnEmail);
    } else if (o.onFill) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'dv-btn dv-primary'; b.dataset.act = 'fill'; b.textContent = o.fillLabel || 'Fill in this document';
      actionsEl.appendChild(b);
    }

    // ------------------------------------------------------------ persistence
    const localKey = () => 'mwdoc:' + (state.user ? state.user.id : 'anon') + ':' + o.ocid + ':' + o.url;
    function snapshot() { return { v: 1, items: state.items, fields: state.fields, defaultSize: state.defaultSize }; }
    function setStatus(text, cls) { if (statusEl) { statusEl.textContent = text; statusEl.className = 'dv-status ' + (cls || ''); } }

    async function saveNow() {
      if (!editable || !state.dirty) return;
      const snap = snapshot();
      try { localStorage.setItem(localKey(), JSON.stringify({ at: Date.now(), state: snap })); } catch (_) {}
      setStatus('Saving…');
      try {
        await MWAuth.api('/api/account/doc-edits', {
          method: 'PUT',
          body: JSON.stringify({ ocid: o.ocid, doc_url: o.url, doc_title: o.title, state: snap }),
        });
        state.dirty = false; state.saveMode = 'server';
        setStatus('All changes saved ✓', 'ok');
      } catch (err) {
        state.saveMode = 'local';
        setStatus('Saved on this device only', 'warn');
        console.warn('[docviewer] server save failed:', err.message);
      }
    }
    const saveSoon = debounce(saveNow, 1200);
    function touch() { if (!editable) return; state.dirty = true; setStatus('Unsaved changes…'); saveSoon(); }

    async function loadSaved() {
      let saved = null;
      try {
        const r = await MWAuth.api('/api/account/doc-edits?ocid=' + encodeURIComponent(o.ocid) + '&doc_url=' + encodeURIComponent(o.url));
        if (r.items && r.items[0] && r.items[0].state) saved = r.items[0].state;
      } catch (err) { state.saveMode = 'local'; }
      if (!saved) {
        try { const l = JSON.parse(localStorage.getItem(localKey()) || 'null'); if (l && l.state) saved = l.state; } catch (_) {}
      }
      if (saved) {
        state.items = Array.isArray(saved.items) ? saved.items : [];
        state.fields = saved.fields && typeof saved.fields === 'object' ? saved.fields : {};
        if (saved.defaultSize) state.defaultSize = saved.defaultSize;
      }
    }

    // ------------------------------------------------------------ rendering
    const renderTasks = new Map();
    let observer = null;

    function fitScale() {
      const avail = Math.max(240, scrollEl.clientWidth - (scrollEl.clientWidth < 700 ? 16 : 48));
      const w1 = state.pages[0] ? state.pages[0].w : 595;
      return Math.min(avail, 1000) / w1 * state.zoom;
    }

    function layoutPages() {
      state.scale = fitScale();
      pagesEl.innerHTML = '';
      if (observer) observer.disconnect();
      observer = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          const n = +en.target.dataset.page;
          if (en.isIntersecting) renderPage(n); else unrenderPage(n);
        });
      }, { root: scrollEl, rootMargin: '900px 0px' });
      state.pages.forEach((p) => {
        const wrap = document.createElement('div');
        wrap.className = 'dv-page';
        wrap.dataset.page = p.n;
        wrap.style.width = Math.round(p.w * state.scale) + 'px';
        wrap.style.height = Math.round(p.h * state.scale) + 'px';
        wrap.innerHTML = '<canvas></canvas><div class="dv-ov"></div><span class="dv-pn">' + p.n + ' / ' + state.pages.length + '</span>';
        p.el = wrap; p.rendered = false;
        pagesEl.appendChild(wrap);
        if (editable) buildOverlay(p);
        observer.observe(wrap);
        if (editable) wrap.addEventListener('pointerdown', (e) => onPagePointer(e, p));
      });
    }

    async function renderPage(n) {
      const p = state.pages[n - 1];
      if (!p || p.rendered || p.rendering) return;
      p.rendering = true;
      try {
        const page = await state.pdf.getPage(n);
        const dpr = Math.min(global.devicePixelRatio || 1, 2);
        const vp = page.getViewport({ scale: state.scale * dpr });
        const canvas = p.el.querySelector('canvas');
        canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
        canvas.style.width = p.el.style.width; canvas.style.height = p.el.style.height;
        const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
        renderTasks.set(n, task);
        await task.promise;
        p.rendered = true;
      } catch (err) {
        if (!(err && err.name === 'RenderingCancelledException')) console.warn('[docviewer] render', n, err);
      } finally { p.rendering = false; renderTasks.delete(n); }
    }
    function unrenderPage(n) {
      const p = state.pages[n - 1];
      if (!p) return;
      const t = renderTasks.get(n); if (t) { try { t.cancel(); } catch (_) {} }
      if (p.rendered) {
        const c = p.el.querySelector('canvas'); c.width = 0; c.height = 0; p.rendered = false;
      }
    }

    // ------------------------------------------------------------ overlay (edit mode)
    function buildOverlay(p) {
      const ov = p.el.querySelector('.dv-ov');
      ov.innerHTML = '';
      const s = state.scale;
      // existing PDF form fields
      (p.widgets || []).forEach((wd) => {
        const [x1, y1, x2, y2] = wd.vp;
        const left = Math.min(x1, x2) * s, top = Math.min(y1, y2) * s;
        const w = Math.abs(x2 - x1) * s, h = Math.abs(y2 - y1) * s;
        let el;
        if (wd.kind === 'text') {
          el = wd.multi ? document.createElement('textarea') : document.createElement('input');
          if (!wd.multi) el.type = 'text';
          el.value = state.fields[wd.name] != null ? state.fields[wd.name] : (wd.value || '');
          el.style.fontSize = Math.max(9, Math.min(h * 0.62, 16 * s)) + 'px';
          el.addEventListener('input', () => { state.fields[wd.name] = el.value; touch(); });
        } else if (wd.kind === 'check' || wd.kind === 'radio') {
          el = document.createElement('button');
          el.type = 'button';
          const on = () => (wd.kind === 'radio' ? state.fields[wd.name] === wd.exportValue : !!state.fields[wd.name]);
          const paint = () => { el.classList.toggle('on', on()); el.textContent = on() ? '✓' : ''; };
          paint();
          el.addEventListener('click', () => {
            if (wd.kind === 'radio') { state.fields[wd.name] = wd.exportValue; p.el.querySelectorAll('.dv-w[data-radio="' + CSS.escape(wd.name) + '"]').forEach((b) => b.dispatchEvent(new Event('repaint'))); }
            else state.fields[wd.name] = !on();
            paint(); touch();
          });
          el.addEventListener('repaint', paint);
          if (wd.kind === 'radio') el.dataset.radio = wd.name;
        } else if (wd.kind === 'choice') {
          el = document.createElement('select');
          el.innerHTML = '<option value=""></option>' + (wd.options || []).map((op) => `<option value="${esc(op.value)}">${esc(op.label)}</option>`).join('');
          el.value = state.fields[wd.name] != null ? state.fields[wd.name] : (wd.value || '');
          el.addEventListener('change', () => { state.fields[wd.name] = el.value; touch(); });
        }
        if (!el) return;
        el.className = 'dv-w dv-w-' + wd.kind;
        el.title = wd.label || wd.name || '';
        Object.assign(el.style, { left: left + 'px', top: top + 'px', width: w + 'px', height: h + 'px' });
        el.addEventListener('focus', () => { state.lastFocus = el; deselect(); });
        ov.appendChild(el);
      });
      // free items
      state.items.filter((it) => it.page === p.n).forEach((it) => ov.appendChild(makeItemEl(it)));
    }

    function makeItemEl(it) {
      const s = state.scale;
      const wrap = document.createElement('div');
      wrap.className = 'dv-item dv-item-' + it.type;
      wrap.dataset.id = it.id;
      const place = () => {
        wrap.style.left = it.x * state.scale + 'px'; wrap.style.top = it.y * state.scale + 'px';
        wrap.style.width = it.w * state.scale + 'px'; wrap.style.height = it.h * state.scale + 'px';
      };
      place();
      const handle = document.createElement('span');
      handle.className = 'dv-handle'; handle.title = 'Drag to move'; handle.textContent = '⠿';
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'dv-x'; del.setAttribute('aria-label', 'Delete'); del.textContent = '×';
      del.addEventListener('click', (e) => { e.stopPropagation(); removeItem(it.id); });
      wrap.appendChild(handle); wrap.appendChild(del);

      if (it.type === 'tick') {
        wrap.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 1 1" preserveAspectRatio="none"><path d="M0.15 0.55 L0.4 0.8 L0.85 0.2" fill="none" stroke="currentColor" stroke-width="0.12" stroke-linecap="round" stroke-linejoin="round"/></svg>');
        wrap.tabIndex = 0;
      } else {
        const ta = document.createElement('textarea');
        ta.value = it.text || '';
        ta.spellcheck = false;
        ta.style.fontSize = it.size * s + 'px';
        ta.setAttribute('aria-label', it.type === 'stamp' ? 'Company stamp' : 'Text box');
        if (it.type === 'stamp') ta.className = 'dv-stamp-ta';
        ta.addEventListener('input', () => {
          it.text = ta.value;
          if (ta.scrollHeight > ta.clientHeight + 1) { it.h = Math.ceil(ta.scrollHeight / state.scale) + (it.type === 'stamp' ? 8 : 2); wrap.style.height = it.h * state.scale + 'px'; }
          touch();
        });
        ta.addEventListener('focus', () => { state.lastFocus = ta; select(it.id); });
        ta.addEventListener('blur', () => {
          // keep highlight only while the box itself still has focus or is being dragged
          setTimeout(() => {
            if (state.selected === it.id && document.activeElement !== ta && !wrap.contains(document.activeElement)) {
              // leave selected if user just clicked the handle; otherwise deselect when focus left the page
            }
          }, 0);
        });
        wrap.insertBefore(ta, wrap.firstChild);
        wrap._ta = ta;
        // native resize handle on the textarea → keep the model in sync
        if (global.ResizeObserver) {
          let first = true;
          new ResizeObserver(() => {
            if (first) { first = false; return; }
            const r = wrap.getBoundingClientRect();
            if (!r.width) return;
            it.w = Math.max(20, r.width / state.scale); it.h = Math.max(it.size * 1.3, r.height / state.scale);
          }).observe(wrap);
        }
      }
      wrap.addEventListener('focusin', () => select(it.id));
      wrap.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.dv-x')) return;
        select(it.id);
      });
      wrap._it = it; wrap._place = place;

      // drag by handle
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        select(it.id);
        const sx = e.clientX, sy = e.clientY, ox = it.x, oy = it.y;
        const p = state.pages[it.page - 1];
        const move = (ev) => {
          it.x = Math.max(0, Math.min(p.w - it.w, ox + (ev.clientX - sx) / state.scale));
          it.y = Math.max(0, Math.min(p.h - it.h, oy + (ev.clientY - sy) / state.scale));
          place();
        };
        const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); touch(); };
        addEventListener('pointermove', move); addEventListener('pointerup', up);
      });
      return wrap;
    }

    function select(id) {
      // Keep one active placement highlighted; previously placed items stay unchanged.
      state.selected = id || null;
      root.querySelectorAll('.dv-item.sel').forEach((el) => el.classList.remove('sel'));
      if (!state.selected) return;
      const active = root.querySelector('.dv-item[data-id="' + CSS.escape(state.selected) + '"]');
      if (active) active.classList.add('sel');
    }
    function deselect() {
      if (!state.selected) return;
      state.selected = null;
      root.querySelectorAll('.dv-item.sel').forEach((e) => e.classList.remove('sel'));
    }
    function removeItem(id) {
      state.items = state.items.filter((i) => i.id !== id);
      const el = root.querySelector('.dv-item[data-id="' + id + '"]'); if (el) el.remove();
      if (state.selected === id) state.selected = null;
      touch();
    }

    function addItem(type, p, x, y, text) {
      const size = state.defaultSize;
      const it = { id: uid(), type, page: p.n, x, y, size, text: text || '' };
      if (type === 'tick') { it.w = size * 1.5; it.h = size * 1.5; }
      else if (type === 'stamp') {
        const lines = String(text || '').split(/\n/).filter(Boolean);
        const longest = lines.reduce((m, ln) => Math.max(m, ln.length), 8);
        it.w = Math.min(p.w - 20, Math.max(120, longest * size * 0.58 + 24));
        it.h = Math.ceil(size * 1.35 * Math.max(2, lines.length) + 16);
      }
      else {
        const textW = text ? Math.min(p.w - 20, Math.max(80, text.length * size * 0.55 + 12)) : 150;
        it.w = textW; it.h = Math.ceil(size * 1.25 * (text && text.includes('\n') ? text.split('\n').length : 1)) + 4;
      }
      // keep inside the page
      it.x = Math.max(0, Math.min(p.w - it.w, x)); it.y = Math.max(0, Math.min(p.h - it.h, y));
      state.items.push(it);
      const el = makeItemEl(it);
      p.el.querySelector('.dv-ov').appendChild(el);
      select(it.id);
      if (el._ta) { el._ta.focus(); }
      touch();
      return it;
    }

    function setTool(t) {
      state.tool = t;
      root.querySelectorAll('.dv-tool').forEach((b) => b.classList.toggle('on', typeof t === 'string' && b.dataset.tool === t));
      root.classList.toggle('dv-placing', !!t);
      hintEl.textContent = !t ? defaultHint()
        : typeof t === 'object' ? 'Now tap on the page where “' + truncate(t.value, 40) + '” should go.'
          : t === 'text' ? 'Tap on the page where you want to type.'
            : t === 'tick' ? 'Tap on the page where the tick should go.'
              : t === 'stamp' ? 'Tap on the page where the company stamp should go.'
                : 'Tap on the page where the date should go.';
    }
    const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
    function defaultHint() {
      return 'Tap a form field to type in it, or use + Text, ✓ Tick, Date or Stamp to write anywhere on the page.';
    }

    function onPagePointer(e, p) {
      if (e.target.closest('.dv-item, .dv-w, .dv-handle, .dv-x')) return;
      if (!state.tool) {
        // Clicked empty page: unhighlight any selected box so only the one being edited stays highlighted
        deselect();
        return;
      }
      const r = p.el.getBoundingClientRect();
      const x = (e.clientX - r.left) / state.scale, y = (e.clientY - r.top) / state.scale;
      const t = state.tool;
      if (t === 'tick') addItem('tick', p, x - 8, y - 8);
      else if (t === 'date') addItem('text', p, x, y - 8, todayText());
      else if (t === 'text') addItem('text', p, x, y - 8);
      else if (t === 'stamp') addItem('stamp', p, x, y - 8, stampText());
      else if (typeof t === 'object') addItem(t.stamp ? 'stamp' : 'text', p, x, y - 8, t.value);
      e.preventDefault();
      setTool(null);
    }

    function stampText() {
      const prof = state.profile || {};
      const name = (prof.registered_name || prof.trading_name || '').trim() || 'Company name';
      const reg = (prof.cipc_number || '').trim();
      const lines = ['COMPANY STAMP', name];
      if (reg) lines.push('Reg. ' + reg);
      lines.push(todayText());
      return lines.join('\n');
    }

    // ------------------------------------------------------------ profile chips
    async function loadProfileChips() {
      const box = $('.dv-chips');
      if (!box) return;
      let prof = null, email = '';
      try { const r = await MWAuth.api('/api/account/profile'); prof = r.profile || {}; email = r.email || ''; } catch (_) { prof = {}; }
      const bank = prof.banking || {};
      const addr = [prof.address_line1, prof.address_line2, prof.city, prof.province, prof.postal_code].filter(Boolean).join(', ');
      const chips = [
        ['Registered name', prof.registered_name], ['Trading name', prof.trading_name],
        ['Registration no.', prof.cipc_number], ['Tax number', prof.tax_number], ['VAT number', prof.vat_number],
        ['Address', addr], ['Phone', prof.contact_phone], ['Email', prof.contact_email || email],
        ['B-BBEE level', prof.bbbee_level ? 'Level ' + prof.bbbee_level : ''],
        ['CIDB grade', prof.cidb_grade], ['CIDB number', prof.cidb_number],
        ['Bank', bank.bank], ['Account no.', bank.account], ['Branch code', bank.branch],
        ['Today’s date', todayText()],
      ].filter(([, v]) => v && String(v).trim());
      state.profile = prof;
      // Always offer a company stamp when we have at least a name
      const stampVal = stampText();
      if ((prof.registered_name || prof.trading_name) && !chips.some(([l]) => l === 'Company stamp')) {
        chips.unshift(['Company stamp', stampVal]);
      }
      if (chips.length <= 1) {
        box.innerHTML = '<p class="dv-profile-help">No company details saved yet. Add them in <strong>Company profile</strong> on your dashboard and they will appear here.</p>';
      } else box.innerHTML = '';
      chips.forEach(([label, value]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'dv-chip';
        b.innerHTML = `<span>${esc(label)}</span><b>${esc(truncate(String(value).replace(/\n/g, ' · '), 60))}</b>`;
        // pointerdown + preventDefault keeps focus on the field the user tapped
        b.addEventListener('pointerdown', (e) => e.preventDefault());
        b.addEventListener('click', () => {
          if (label === 'Company stamp') useValue(String(value), true);
          else useValue(String(value), false);
        });
        box.appendChild(b);
      });
    }
    function useValue(value, asStamp) {
      const f = state.lastFocus;
      if (f && f.isConnected && root.contains(f) && !asStamp) {
        f.value = value;
        f.dispatchEvent(new Event('input', { bubbles: true }));
        f.focus();
        return;
      }
      setTool({ value, stamp: !!asStamp });
      if (global.matchMedia && matchMedia('(max-width: 760px)').matches) $('.dv-profile').hidden = true;
    }

    // ------------------------------------------------------------ export
    async function buildFilledPdf() {
      const L = global.PDFLib;
      const doc = await L.PDFDocument.load(state.bytes.slice(0), { ignoreEncryption: true, updateMetadata: false });
      // 1. PDF form fields
      try {
        const form = doc.getForm();
        Object.entries(state.fields).forEach(([name, val]) => {
          try {
            const f = form.getField(name);
            if (f instanceof L.PDFTextField) f.setText(val == null ? '' : String(val));
            else if (f instanceof L.PDFCheckBox) { if (val) f.check(); else f.uncheck(); }
            else if (f instanceof L.PDFRadioGroup) { if (val) f.select(String(val)); }
            else if (f instanceof L.PDFDropdown || f instanceof L.PDFOptionList) { if (val) f.select(String(val)); }
          } catch (e) { console.warn('[docviewer] field', name, e.message); }
        });
        try { form.flatten(); } catch (e) { console.warn('[docviewer] flatten', e.message); }
      } catch (e) { /* no form in this PDF */ }
      // 2. free text / ticks / dates
      const font = await doc.embedFont(L.StandardFonts.Helvetica);
      const black = L.rgb(0.04, 0.04, 0.12);
      state.items.forEach((it) => {
        const p = state.pages[it.page - 1];
        if (!p) return;
        const page = doc.getPage(it.page - 1);
        const vp = p.vp1; // viewport at scale 1 (handles page rotation + crop box)
        const rot = p.rotation || 0;
        const toPdf = (x, y) => vp.convertToPdfPoint(x, y);
        if (it.type === 'tick') {
          const side = it.w;
          const pt = (u, v) => { const [px, py] = toPdf(it.x + u * side, it.y + v * side); return { x: px, y: py }; };
          const a = pt(0.15, 0.55), b = pt(0.4, 0.8), c = pt(0.85, 0.2);
          const thickness = Math.max(1, side * 0.11);
          page.drawLine({ start: a, end: b, thickness, color: black, lineCap: 1 });
          page.drawLine({ start: b, end: c, thickness, color: black, lineCap: 1 });
          return;
        }
        const text = safeText(font, it.text || '');
        if (!text.trim()) return;
        if (it.type === 'stamp') {
          // Draw a simple rectangular company stamp
          const [x0, y0] = toPdf(it.x, it.y);
          const [x1, y1] = toPdf(it.x + it.w, it.y + it.h);
          const left = Math.min(x0, x1), bottom = Math.min(y0, y1);
          const width = Math.abs(x1 - x0), height = Math.abs(y1 - y0);
          page.drawRectangle({
            x: left, y: bottom, width, height,
            borderWidth: 1.5, borderColor: black, color: L.rgb(1, 1, 1),
            opacity: 0.92, borderOpacity: 1,
          });
          // Inner border for a classic stamp look
          const inset = 3;
          page.drawRectangle({
            x: left + inset, y: bottom + inset, width: Math.max(0, width - inset * 2), height: Math.max(0, height - inset * 2),
            borderWidth: 0.8, borderColor: black, color: undefined, borderOpacity: 0.85,
          });
        }
        const pad = it.type === 'stamp' ? 6 : 2;
        const lines = wrapLines(text, font, it.size, Math.max(10, it.w - pad * 2));
        lines.forEach((ln, k) => {
          if (!ln) return;
          const [px, py] = toPdf(it.x + pad, it.y + pad + it.size * 0.9 + k * it.size * 1.25);
          page.drawText(ln, { x: px, y: py, size: it.size, font, color: black, rotate: L.degrees(rot) });
        });
      });
      return doc.save();
    }

    async function withBusy(btn, label, fn) {
      const old = btn.textContent; btn.disabled = true; btn.textContent = label;
      try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
    }

    async function doDownload(btn) {
      if (!state.bytes) return;
      if (!editable) { download(new Uint8Array(state.bytes), slug(o.title) + '.pdf'); return; }
      await withBusy(btn, 'Preparing…', async () => {
        try { const out = await buildFilledPdf(); download(out, slug(o.title) + '-filled.pdf'); }
        catch (err) { alert('Could not prepare the PDF: ' + err.message); }
      });
    }

    // ------------------------------------------------------------ email dialog
    const emailEl = $('.dv-email');
    function openEmail() {
      if (!emailEl) return;
      const f = emailEl.querySelector('form');
      f.subject.value = f.subject.value || ('Tender document: ' + (o.tenderTitle || o.title || ''));
      if (!f.to.value && state.user && state.user.email) f.to.value = '';
      emailEl.hidden = false;
      f.to.focus();
    }
    function emailMsg(text, cls) {
      const m = emailEl.querySelector('.dv-email-msg');
      m.hidden = !text; m.textContent = text || ''; m.className = 'dv-email-msg ' + (cls || '');
    }
    if (emailEl) {
      const form = emailEl.querySelector('form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const to = form.to.value.trim();
        if (!to) { emailMsg('Enter an email address to send to.', 'err'); form.to.focus(); return; }
        const send = form.querySelector('[type=submit]');
        send.disabled = true; send.textContent = 'Sending…'; emailMsg('Preparing your document…');
        try {
          const out = await buildFilledPdf();
          if (out.length > 12 * 1024 * 1024) throw new Error('The document is over 12 MB, too large to email. Download it and send it yourself.');
          emailMsg('Sending…');
          await saveNow();
          const r = await MWAuth.api('/api/account/docs/email', {
            method: 'POST',
            body: JSON.stringify({
              to, subject: form.subject.value, message: form.message.value, cc_me: form.cc_me.checked,
              filename: slug(o.title) + '-filled.pdf', pdf_base64: bytesToBase64(out),
            }),
          });
          emailMsg('Sent to ' + (r.sent_to || [to]).join(', ') + ' ✓', 'ok');
          send.textContent = 'Send again';
        } catch (err) {
          emailMsg(err.message || 'Could not send the email.', 'err');
          send.textContent = 'Send email';
        } finally { send.disabled = false; }
      });
      emailEl.addEventListener('click', (e) => { if (e.target === emailEl) emailEl.hidden = true; });
    }
    async function emailOwnApp(btn) {
      const f = emailEl.querySelector('form');
      await withBusy(btn, 'Preparing…', async () => {
        try {
          const out = await buildFilledPdf();
          const filename = slug(o.title) + '-filled.pdf';
          const to = f.to.value.trim().replace(/\s+/g, '');
          const subject = f.subject.value || ('Tender document: ' + (o.tenderTitle || o.title || ''));
          const message = f.message.value || '';
          const file = new File([out], filename, { type: 'application/pdf' });

          // Native share can pass the actual PDF attachment to Gmail, Outlook or Mail.
          if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: subject, text: (to ? 'Recipient: ' + to + '\\n\\n' : '') + message });
            emailMsg('Choose Gmail, Outlook or your preferred email app to send the attached PDF.', 'ok');
            return;
          }

          // mailto cannot attach files. Fallback: download the PDF and open the configured email app.
          download(out, filename);
          const body = (message ? message + '\n\n' : '') +
            '—\nPlease attach the PDF that was just downloaded: ' + filename;
          location.href = 'mailto:' + encodeURIComponent(to).replace(/%2C/g, ',').replace(/%40/g, '@') +
            '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
          emailMsg('Your email app is opening. Attach the downloaded PDF before sending.', 'ok');
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          emailMsg(err.message || 'Could not open your email app.', 'err');
        }
      });
    }
    // ------------------------------------------------------------ events
    root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-act],[data-tool]');
      if (!t || !root.contains(t)) return;
      if (t.dataset.tool) { setTool(state.tool === t.dataset.tool ? null : t.dataset.tool); return; }
      switch (t.dataset.act) {
        case 'zoom-in': state.zoom = Math.min(3, state.zoom + 0.25); relayout(); break;
        case 'zoom-out': state.zoom = Math.max(0.5, state.zoom - 0.25); relayout(); break;
        case 'download': doDownload(t); break;
        case 'fill': if (o.onFill) o.onFill(t); break;
        case 'email': saveNow().then(openEmail); break;
        case 'email-cancel': emailEl.hidden = true; break;
        case 'email-own': emailOwnApp(t); break;
        case 'profile-toggle': { const pr = $('.dv-profile'); pr.hidden = !pr.hidden; if (state.pdf) setTimeout(() => { if (Math.abs(fitScale() - state.scale) > 0.01) relayout(); }, 0); break; }
        case 'size-up': case 'size-down': {
          const d = t.dataset.act === 'size-up' ? 1 : -1;
          const it = state.items.find((i) => i.id === state.selected && i.type !== 'tick') || null;
          const tick = state.items.find((i) => i.id === state.selected && i.type === 'tick') || null;
          if (it) { it.size = Math.max(6, Math.min(28, it.size + d)); state.defaultSize = it.size; const el = root.querySelector('.dv-item[data-id="' + it.id + '"] textarea'); if (el) el.style.fontSize = it.size * state.scale + 'px'; touch(); }
          else if (tick) { tick.size = Math.max(6, Math.min(28, tick.size + d)); tick.w = tick.h = tick.size * 1.5; root.querySelector('.dv-item[data-id="' + tick.id + '"]')._place(); touch(); }
          else { state.defaultSize = Math.max(6, Math.min(28, state.defaultSize + d)); setStatus('New text size: ' + state.defaultSize + ' pt'); }
          break;
        }
        case 'delete': if (state.selected) removeItem(state.selected); break;
        default:
      }
    });
    $('.dv-close').addEventListener('click', close);
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (emailEl && !emailEl.hidden) { emailEl.hidden = true; return; }
      if (state.tool) { setTool(null); return; }
      close();
    };
    document.addEventListener('keydown', onKey);
    let rzT = null;
    const onResize = () => { clearTimeout(rzT); rzT = setTimeout(() => { if (state.pdf && Math.abs(fitScale() - state.scale) > 0.01) relayout(); }, 200); };
    global.addEventListener('resize', onResize);

    function relayout() {
      const top = scrollEl.scrollTop, h = scrollEl.scrollHeight;
      layoutPages();
      scrollEl.scrollTop = h ? top * (scrollEl.scrollHeight / h) : 0;
    }

    async function close() {
      if (state.closed) return;
      state.closed = true;
      if (editable && state.dirty) { try { await saveNow(); } catch (_) {} }
      document.removeEventListener('keydown', onKey);
      global.removeEventListener('resize', onResize);
      if (observer) observer.disconnect();
      try { state.pdf && state.pdf.destroy(); } catch (_) {}
      root.remove();
      document.body.style.overflow = prevOverflow;
      if (o.onClose) o.onClose();
    }

    // ------------------------------------------------------------ boot
    function fail(msg, showDownload) {
      pagesEl.innerHTML = `<div class="dv-fail"><p>${esc(msg)}</p>${showDownload && o.url ? `<p><a class="dv-btn dv-primary" href="${esc(o.url)}" target="_blank" rel="noopener">Download the original file</a></p>` : ''}</div>`;
    }

    (async function boot() {
      try {
        if (editable) {
          state.user = global.MWAuth ? await MWAuth.getUser() : null;
          if (!state.user) { fail('Please sign in to fill in documents.'); return; }
        }
        const [pdfjs] = await Promise.all([loadLibs(editable)]);
        let buf;
        try {
          const res = await fetch(proxied(o.url));
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            throw new Error(j.error || 'The document could not be loaded.');
          }
          buf = await res.arrayBuffer();
        } catch (err) {
          fail(err.message || 'The document could not be loaded.', true); return;
        }
        if (!isPdfBytes(buf)) { fail('This file isn’t a PDF, so it can’t be previewed here. You can download it instead.', true); return; }
        state.bytes = new Uint8Array(buf);
        state.pdf = await pdfjs.getDocument({ data: state.bytes.slice(0) }).promise;

        // page sizes up-front so scrolling is stable
        const n = state.pdf.numPages;
        const infos = new Array(n);
        const widgetsByPage = new Array(n).fill(null);
        const batch = 12;
        for (let i = 1; i <= n; i += batch) {
          await Promise.all(Array.from({ length: Math.min(batch, n - i + 1) }, async (_, k) => {
            const pn = i + k;
            const page = await state.pdf.getPage(pn);
            const vp1 = page.getViewport({ scale: 1 });
            infos[pn - 1] = { n: pn, w: vp1.width, h: vp1.height, vp1, rotation: page.rotate || 0 };
            if (editable) {
              try {
                const anns = await page.getAnnotations({ intent: 'display' });
                infos[pn - 1].widgets = anns.filter((a) => a.subtype === 'Widget' && !a.readOnly && a.fieldName).map((a) => {
                  const kind = a.fieldType === 'Tx' ? 'text' : a.fieldType === 'Btn' ? (a.checkBox ? 'check' : a.radioButton ? 'radio' : null) : a.fieldType === 'Ch' ? 'choice' : null;
                  if (!kind) return null;
                  return {
                    kind, name: a.fieldName, vp: viewportRect(vp1, a.rect),
                    multi: !!a.multiLine, value: Array.isArray(a.fieldValue) ? a.fieldValue[0] : a.fieldValue,
                    exportValue: a.buttonValue || a.exportValue || 'Yes', options: a.options, label: a.alternativeText || a.fieldName,
                  };
                }).filter(Boolean);
              } catch (err) { console.warn('[docviewer] annotations', err); infos[pn - 1].widgets = []; }
            }
          }));
        }
        state.pages = infos;
        if (editable) await loadSaved();
        btnDownload.disabled = false; if (btnEmail) btnEmail.disabled = false;
        pagesEl.innerHTML = '';
        // open the quick-fill side panel first (desktop) so pages are sized to the space that is left
        if (editable && global.matchMedia && matchMedia('(min-width: 1000px)').matches) $('.dv-profile').hidden = false;
        layoutPages();
        if (editable) {
          const nFields = infos.reduce((a, p) => a + (p.widgets || []).length, 0);
          hintEl.textContent = nFields ? 'This PDF has ' + nFields + ' fillable fields (highlighted). You can also add text, ticks and dates anywhere.' : defaultHint();
          if (state.saveMode === 'local') setStatus('Saved on this device only', 'warn'); else setStatus(state.items.length || Object.keys(state.fields).length ? 'Loaded your saved copy ✓' : '', 'ok');
          loadProfileChips();
        }
      } catch (err) {
        console.error('[docviewer]', err);
        fail('Sorry, this document could not be opened (' + (err.message || 'unknown error') + ').', true);
      }
    })();

    return { close };
  }

  // Word / Excel / zip files can't be shown in the browser
  function canPreview(d) {
    const s = ((d.format || '') + ' ' + (d.url || '') + ' ' + (d.title || '')).toLowerCase();
    if (/\.(docx?|xlsx?|pptx?|zip|rar|7z|csv|txt|rtf)(\b|$|\?)/.test(s)) return false;
    if (/(msword|wordprocessing|spreadsheet|ms-excel|powerpoint|zip|rar)/.test(s)) return false;
    return !!d.url;
  }

  global.MWDocViewer = { open, canPreview };
})(window);
