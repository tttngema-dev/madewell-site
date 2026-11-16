/**
 * Public config for the Made Well frontend.
 * Replace SUPABASE_* with your project values (anon key is safe to expose).
 */
window.MADEWELL = {
  apiBase: (function () {
    const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
    return isLocal ? 'http://localhost:4000' : 'https://madewell-backend.onrender.com';
  })(),
  // Supabase (Auth + optional direct DB)
  supabaseUrl: 'https://cspjwtgtdpdkkbywvvqh.supabase.co',
  supabaseAnonKey: 'sb_publishable_OibnybLFg6s96dUYvOG-QA_CLKjqQGR',
};
