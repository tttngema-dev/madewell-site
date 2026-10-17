import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

// Server-side client — uses the service role key, bypasses RLS.
// NEVER import this file into anything that runs in a browser.
export const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false },
});