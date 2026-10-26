import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { ordersRouter } from './routes/orders.js';
import { registrationsRouter } from './routes/registrations.js';
import { payfastRouter } from './payfast.js';
import { remindersRouter } from './routes/reminders.js';

const app = express();
const PORT = process.env.PORT || 4000;

const allowed = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim());

app.use(cors({ origin: allowed, credentials: true }));
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) =>
  res.json({ ok: true, service: 'madewell-backend' })
);

app.use('/api', ordersRouter);
app.use('/api', registrationsRouter);
app.use('/api', payfastRouter);
app.use('/api', remindersRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => console.log(`Backend listening on :${PORT}`));