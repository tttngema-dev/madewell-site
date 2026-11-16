/**
 * Verify Supabase JWT from Authorization: Bearer <token>
 * Attaches req.user = { id, email }
 */
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let adminClient = null;
function getAdmin() {
  if (!adminClient) {
    if (!url || !serviceKey) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    adminClient = createClient(url, serviceKey, { auth: { persistSession: false } });
  }
  return adminClient;
}

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ ok: false, error: 'Sign in required' });
    }
    const { data, error } = await getAdmin().auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ ok: false, error: 'Invalid or expired session' });
    }
    req.user = { id: data.user.id, email: data.user.email };
    req.accessToken = token;
    next();
  } catch (err) {
    console.error('[auth]', err.message);
    res.status(500).json({ ok: false, error: 'Auth check failed' });
  }
}

export function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next();
  getAdmin()
    .auth.getUser(token)
    .then(({ data }) => {
      if (data?.user) req.user = { id: data.user.id, email: data.user.email };
      next();
    })
    .catch(() => next());
}
