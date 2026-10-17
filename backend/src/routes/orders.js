import { Router } from 'express';
import { supabase } from '../supabase.js';

export const ordersRouter = Router();

// GET /api/packages — public list of what's for sale
ordersRouter.get('/packages', async (_req, res) => {
  const { data, error } = await supabase
    .from('packages')
    .select('id, slug, name, price_cents, currency, includes')
    .eq('active', true);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ packages: data });
});

// POST /api/orders — create a pending order
ordersRouter.post('/orders', async (req, res) => {
  const { package_slug, email, full_name } = req.body ?? {};

  if (!package_slug || !email) {
    return res.status(400).json({ error: 'package_slug and email are required' });
  }

  const { data: pkg, error: pkgErr } = await supabase
    .from('packages')
    .select('id, price_cents, currency')
    .eq('slug', package_slug)
    .eq('active', true)
    .single();

  if (pkgErr || !pkg) {
    return res.status(404).json({ error: 'Package not found' });
  }

  const { data: customer, error: custErr } = await supabase
    .from('customers')
    .upsert({ email, full_name }, { onConflict: 'email' })
    .select()
    .single();

  if (custErr) return res.status(500).json({ error: custErr.message });

  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .insert({
      customer_id: customer.id,
      package_id: pkg.id,
      amount_cents: pkg.price_cents,
      currency: pkg.currency,
      status: 'pending_payment',
    })
    .select()
    .single();

  if (orderErr) return res.status(500).json({ error: orderErr.message });

  res.status(201).json({ order });
});

// GET /api/orders/:id — fetch a single order
ordersRouter.get('/orders/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('orders')
    .select('id, status, amount_cents, currency, created_at')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ error: 'Order not found' });
  res.json({ order: data });
});