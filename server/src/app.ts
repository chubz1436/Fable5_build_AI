import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { SystemStatus } from '../../shared/types';
import { AttemptService } from './attempts/service';
import { loadConfig, repoRoot, type AppConfig } from './config';
import { Db, importLegacyJson } from './db/db';
import { Engine } from './engine/engine';
import { createRoutes } from './api/routes';
import { sseHandler } from './api/sse';
import {
  apiAuthGate,
  authExchangeHandler,
  buildAuthContext,
  resolveAuthToken,
  securityHeaders,
  type AuthContext,
} from './security/auth';
import { seedIfEmpty } from './store/seed';
import { Store } from './store/store';
import { nowIso, uid } from './domain/util';

export interface AppContext {
  config: AppConfig;
  db: Db;
  store: Store;
  engine: Engine;
  attempts: AttemptService;
  auth: AuthContext;
  authToken: string;
  startedAt: string;
  systemStatus(): SystemStatus;
}

export function createContext(overrides: Partial<AppConfig> = {}): AppContext {
  const config = loadConfig(overrides);
  const db = new Db(config.dbFile);
  importLegacyJson(db, config.legacyJsonFile);
  const store = new Store(db);
  seedIfEmpty(store);
  const engine = new Engine(store, config);
  const attempts = new AttemptService(store, config);
  if (config.recoverOnBoot) {
    engine.recoverInterrupted();
    void attempts.recover().catch((err) => console.error('attempt recovery failed:', err));
  }
  const authToken = resolveAuthToken(config);
  const auth = buildAuthContext(config, authToken);
  const startedAt = nowIso();

  return {
    config,
    db,
    store,
    engine,
    attempts,
    auth,
    authToken,
    startedAt,
    systemStatus(): SystemStatus {
      const hasReal = store.workers.some((w) => w.integration === 'real');
      return {
        startedAt,
        version: config.version,
        engine: hasReal ? 'simulated + real adapters' : 'simulated',
        simSpeed: config.simSpeed,
        dataFile: config.dbFile,
      };
    },
  };
}

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.json({ limit: '256kb' }));

  // browser auth exchange: printed link → session cookie
  app.get('/auth/:token', authExchangeHandler(ctx.auth));

  // every /api route requires the local token (bearer or cookie)
  app.use('/api', apiAuthGate(ctx.auth));
  app.get('/api/stream', sseHandler(ctx));
  app.use('/api', createRoutes(ctx));

  // Serve the built client when it exists (production / npm start).
  const clientDist = path.join(repoRoot, 'client', 'dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    // SPA fallback for non-API GET routes
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api')) {
        res.sendFile(path.join(clientDist, 'index.html'));
      } else {
        next();
      }
    });
  }

  // error handler: domain errors carry statusCode; never leak stacks
  app.use((err: Error & { statusCode?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    // body-parser errors (oversized/malformed payloads)
    if (err.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request body too large.', code: 'PAYLOAD_TOO_LARGE' });
      return;
    }
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Malformed JSON body.', code: 'BAD_JSON' });
      return;
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      const correlationId = uid('err');
      console.error(`[${correlationId}]`, err);
      res.status(500).json({ error: 'Internal error.', code: 'INTERNAL', correlationId });
      return;
    }
    res.status(status).json({ error: err.message, code: (err as { code?: string }).code ?? 'DOMAIN' });
  });

  return app;
}
