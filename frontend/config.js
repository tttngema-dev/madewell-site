/**
 * Public config for the Made Well frontend.
 * Replace SUPABASE_* with your project values (anon key is safe to expose).
 */
window.MADEWELL = {
  apiBase: (function () {
    const host = location.hostname;
    // 1. Your own computer  -> backend running on your computer
    if (['localhost', '127.0.0.1'].includes(host)) return 'http://localhost:4000';
    // 2. Cloudflare preview/test links for the "staging" branch, e.g.
    //    staging-madewell-site.<your-subdomain>.workers.dev  -> the STAGING backend on Render
    //    (the live site never matches this, so it is not affected)
    if (/^[a-z0-9-]+-madewell-site\.[a-z0-9-]+\.workers\.dev$/i.test(host)) return 'https://madewell-backend-staging.onrender.com';
    // 3. The live site -> live backend
    return 'https://madewell-backend.onrender.com';
  })(),
  // Supabase (Auth + optional direct DB)
  supabaseUrl: 'https://cspjwtgtdpdkkbywvvqh.supabase.co',
  supabaseAnonKey: 'sb_publishable_OibnybLFg6s96dUYvOG-QA_CLKjqQGR',
};
