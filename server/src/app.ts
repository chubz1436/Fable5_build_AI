import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { SystemStatus } from '../../shared/types';
import { loadConfig, repoRoot, type AppConfig } from './config';
import { Engine } from './engine/engine';
import { createRoutes } from './api/routes';
import { sseHandler } from './api/sse';
import { seedIfEmpty } from './store/seed';
import { Store } from './store/store';
import { nowIso } from './domain/util';

export interface AppContext {
  config: AppConfig;
  store: Store;
  engine: Engine;
  startedAt: string;
  systemStatus(): SystemStatus;
}

export function createContext(overrides: Partial<AppConfig> = {}): AppContext {
  const config = loadConfig(overrides);
  const store = new Store(config.dataFile);
  seedIfEmpty(store);
  const engine = new Engine(store, config);
  if (config.recoverOnBoot) engine.recoverInterrupted();
  const startedAt = nowIso();

  return {
    config,
    store,
    engine,
    startedAt,
    systemStatus(): SystemStatus {
      const hasReal = store.workers.some((w) => w.integration === 'real');
      return {
        startedAt,
        version: config.version,
        engine: hasReal ? 'simulated + claude-code' : 'simulated',
        simSpeed: config.simSpeed,
        dataFile: config.dataFile,
      };
    },
  };
}

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.use(express.json());

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

  // error handler: domain errors carry statusCode
  app.use((err: Error & { statusCode?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status = err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message });
  });

  return app;
}
