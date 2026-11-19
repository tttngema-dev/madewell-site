/**
 * Shared Supabase auth helpers for Made Well pages.
 * Requires config.js and @supabase/supabase-js (CDN).
 */
(function (global) {
  const cfg = global.MADEWELL || {};
  let client = null;

  function getClient() {
    if (client) return client;
    if (!global.supabase || !global.supabase.createClient) {
      throw new Error('Supabase JS not loaded. Include the CDN script before auth.js');
    }
    if (!cfg.supabaseUrl || cfg.supabaseUrl.includes('YOUR_PROJECT')) {
      console.warn('Set supabaseUrl and supabaseAnonKey in config.js');
    }
    client = global.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
    return client;
  }

  async function getSession() {
    const { data, error } = await getClient().auth.getSession();
    if (error) return null;
    return data.session;
  }

  async function getUser() {
    const session = await getSession();
    return session?.user || null;
  }

  async function getAccessToken() {
    const session = await getSession();
    return session?.access_token || null;
  }

  async function api(path, options = {}) {
    const token = await getAccessToken();
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      options.headers || {}
    );
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${cfg.apiBase}${path}`, {
      ...options,
      headers,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || res.statusText);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function signUp(email, password) {
    return getClient().auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${location.origin}/dashboard.html` },
    });
  }

  async function signIn(email, password) {
    return getClient().auth.signInWithPassword({ email, password });
  }

  async function signInMagic(email) {
    return getClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${location.origin}/dashboard.html` },
    });
  }

  // ---- one-time email codes (no links) ----
  async function verifySignupCode(email, token) {
    return getClient().auth.verifyOtp({ email, token: String(token).replace(/\s+/g, ''), type: 'signup' });
  }
  async function resendSignupCode(email) {
    return getClient().auth.resend({ type: 'signup', email });
  }
  async function sendLoginCode(email) {
    // only for people who already have an account; new people use "Create account"
    return getClient().auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  }
  async function verifyLoginCode(email, token) {
    return getClient().auth.verifyOtp({ email, token: String(token).replace(/\s+/g, ''), type: 'email' });
  }

  async function signOut() {
    return getClient().auth.signOut();
  }

  async function requireUser(redirectTo = 'login.html') {
    const user = await getUser();
    if (!user) {
      location.href = `${redirectTo}?next=${encodeURIComponent(location.pathname + location.search)}`;
      return null;
    }
    return user;
  }

  async function hydrateNav() {
    const user = await getUser();
    document.querySelectorAll('[data-auth="guest"]').forEach((el) => {
      el.hidden = !!user;
    });
    document.querySelectorAll('[data-auth="user"]').forEach((el) => {
      el.hidden = !user;
    });
    document.querySelectorAll('[data-auth-email]').forEach((el) => {
      if (user) el.textContent = user.email || '';
    });
  }

  // Where to go after signing in / registering. Only paths on this site are allowed.
  function safeNext(raw, fallback) {
    raw = String(raw || '');
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//') || raw.includes('\\')) return fallback || 'dashboard.html';
    return raw.replace(/^\//, '');
  }
  // "I was in the middle of something": remembered across sign-in / account creation (same browser, 6 hours).
  function setPending(o) { try { localStorage.setItem('mw:pending', JSON.stringify(Object.assign({}, o, { t: Date.now() }))); } catch (_) {} }
  function takePending() {
    try {
      const o = JSON.parse(localStorage.getItem('mw:pending') || 'null');
      localStorage.removeItem('mw:pending');
      if (o && Date.now() - o.t < 6 * 3600e3) return o;
    } catch (_) {}
    return null;
  }

  global.MWAuth = {
    safeNext,
    setPending,
    takePending,
    getClient,
    getSession,
    getUser,
    getAccessToken,
    api,
    signUp,
    signIn,
    signInMagic,
    verifySignupCode,
    resendSignupCode,
    sendLoginCode,
    verifyLoginCode,
    signOut,
    requireUser,
    hydrateNav,
  };
})(window);
