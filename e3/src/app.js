'use strict';
/**
 * app.js - Express application for Engine 3.
 * Exported for tests / for mounting inside the team's main backend.
 * Run standalone with:  npm start
 */

const express = require('express');
const eventRoutes = require('./routes/eventRoutes');
const { closePool } = require('./config/db');
const { ConflictError, ValidationError, NotFoundError, DatabaseError } = require('./services/transactionService');

const app = express();
app.use(express.json());

// Top-level health checks
app.get('/health', (req, res) => res.json({ status: 'ok', database: true }));
app.get('/health/db', async (req, res, next) => {
  try {
    const { getPool } = require('./config/db');
    const { rows } = await getPool().query('SELECT 1 AS ok');
    res.json({ status: 'healthy', database: 'connected', ok: rows[0].ok === 1 });
  } catch (err) {
    next(err);
  }
});

app.use('/api', eventRoutes);

// Unknown route
app.use((req, res) => {
  res.status(404).json({ error: { name: 'NotFound', message: `Route ${req.method} ${req.originalUrl} not found` } });
});

// Central error handler: domain error -> HTTP status
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Malformed JSON body etc.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { name: 'ValidationError', message: 'Request body is not valid JSON' } });
  }

  let status = 500;
  if (err instanceof NotFoundError) status = 404;
  else if (err instanceof ValidationError) status = 400;
  else if (err instanceof ConflictError) status = 409;
  else if (err instanceof DatabaseError && err.retryable) status = 503;

  if (status === 500) console.error('[error]', err);

  res.status(status).json({
    error: {
      name: err.name,
      message: status === 500 ? 'Internal server error' : err.message,
      kind: err.kind || undefined,
      code: err.code || undefined,
      ...(err.extra ? { details: err.extra } : {}),
    },
  });
});

if (require.main === module) {
  const port = parseInt(process.env.PORT || '3000', 10);
  const server = app.listen(port, () => console.log(`Engine 3 listening on http://localhost:${port}/api`));

  const shutdown = async () => {
    server.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = app;
