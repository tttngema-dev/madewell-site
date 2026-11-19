import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { ordersRouter } from './routes/orders.js';
import { registrationsRouter } from './routes/registrations.js';
import { payfastRouter } from './payfast.js';
import { remindersRouter } from './routes/reminders.js';
import { trackRouter, adminRouter } from './routes/admin.js';
import { beneficialRouter } from './routes/beneficial.js';
import { tendersRouter } from './routes/tenders.js';
import { accountRouter } from './routes/account.js';
import { docsRouter } from './routes/docs.js';
import { companyDocsRouter } from './routes/companyDocs.js';
import { alertsRouter } from './routes/alerts.js';
import { billingRouter } from './routes/billing.js';

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 4000;

const allowed = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim());

// ALLOWED_ORIGINS may contain wildcards, e.g. https://*.workers.dev (handy for preview/staging sites)
const originRules = allowed.map((o) =>
  o.includes('*')
    ? new RegExp('^' + o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9.-]+') + '$', 'i')
    : o
);
const originOk = (origin) => !origin || originRules.some((r) => (typeof r === 'string' ? r === origin : r.test(origin)));
app.use(cors({ origin: (origin, cb) => cb(null, originOk(origin)), credentials: true }));
app.use('/api/bo', express.json({ limit: '15mb' }), beneficialRouter);
app.use('/api/account/docs/email', express.json({ limit: '20mb' })); // filled PDFs arrive as base64
app.use('/api/account/company-docs', express.json({ limit: '14mb' })); // uploaded scans arrive as base64
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) =>
  res.json({ ok: true, service: 'madewell-backend' })
);

app.use('/api', ordersRouter);
app.use('/api', registrationsRouter);
app.use('/api', payfastRouter);
app.use('/api', remindersRouter);
app.use('/api', trackRouter);
app.use('/api', adminRouter);
app.use('/api', tendersRouter);
app.use('/api', accountRouter);
app.use('/api', docsRouter);
app.use('/api', companyDocsRouter);
app.use('/api', alertsRouter);
app.use('/api', billingRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => console.log(`Backend listening on :${PORT}`));
