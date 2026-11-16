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

  global.MWAuth = {
    getClient,
    getSession,
    getUser,
    getAccessToken,
    api,
    signUp,
    signIn,
    signInMagic,
    signOut,
    requireUser,
    hydrateNav,
  };
})(window);
