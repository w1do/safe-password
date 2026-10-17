import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { apiRouter } from './api.js';
import { FailureLimiter } from './auth.js';
import type { AppConfig } from './config.js';
import { VaultError } from './errors.js';
import type { Logger } from './logger.js';
import { mcpRouter } from './mcp.js';
import type { Vault } from './vault.js';

export interface AppDeps {
  vault: Vault;
  config: AppConfig;
  log: Logger;
  loginLimiter?: FailureLimiter;
  mcpLimiter?: FailureLimiter;
}

const FIFTEEN_MIN = 15 * 60_000;

export function createApp({ vault, config, log, loginLimiter, mcpLimiter }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  // Request log: method, path without query, status and duration only — no headers or bodies.
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    const urlPath = req.path;
    res.on('finish', () => {
      if (urlPath === '/api/health') return;
      log.info('request', {
        method: req.method,
        path: urlPath,
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - start) / 1_000_000n),
      });
    });
    next();
  });

  const noStore = (_req: Request, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
  const json = express.json({ limit: '256kb' });

  app.use('/api', noStore, json, apiRouter(vault, config, log, loginLimiter ?? new FailureLimiter(5, 50, FIFTEEN_MIN)));
  app.use('/mcp', noStore, json, mcpRouter(vault, log, mcpLimiter ?? new FailureLimiter(20, 200, FIFTEEN_MIN)));

  if (config.webDir && fs.existsSync(path.join(config.webDir, 'index.html'))) {
    const webDir = config.webDir;
    app.use(express.static(webDir, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/(api|mcp)(\/|$)).*/, (_req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.sendFile(path.join(webDir, 'index.html'));
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof VaultError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.details } });
      return;
    }
    const e = err as { type?: string; status?: number; message?: string };
    if (e?.type === 'entity.parse.failed' || e?.type === 'entity.too.large') {
      res.status(e.status ?? 400).json({ error: { code: 'VALIDATION_ERROR', message: e.type === 'entity.too.large' ? 'Request body too large' : 'Malformed JSON body' } });
      return;
    }
    // Only the message is logged, never the request.
    log.error('Unhandled error', { path: req.path, error: e?.message });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  return app;
}
