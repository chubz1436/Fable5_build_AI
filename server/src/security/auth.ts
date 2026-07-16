import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '../config';

/**
 * Local security boundary (P0.1):
 *  - the server binds to loopback by default (enforced in index.ts);
 *  - every /api request requires the local access token, presented either as
 *    a Bearer header (tools/tests) or the session cookie set by visiting
 *    GET /auth/<token> once (browser);
 *  - mutating requests with a browser Origin header must come from an
 *    allowed local origin (CSRF defence on top of SameSite=Strict);
 *  - conservative security headers; no secrets or stack traces in errors.
 */

const COOKIE_NAME = 'cc_session';

/** load the token from config/env, or create one on first boot */
export function resolveAuthToken(config: AppConfig): string {
  if (config.authToken) return config.authToken;
  try {
    const existing = fs.readFileSync(config.authTokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* first boot */
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(config.authTokenFile), { recursive: true });
  fs.writeFileSync(config.authTokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  return token;
}

function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function cookieToken(req: Request): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
}

export interface AuthContext {
  token: string;
  allowedOrigins: Set<string>;
}

export function buildAuthContext(config: AppConfig, token: string): AuthContext {
  const allowedOrigins = new Set<string>();
  for (const host of ['localhost', '127.0.0.1']) {
    allowedOrigins.add(`http://${host}:${config.port}`);
    allowedOrigins.add(`http://${host}:5173`); // vite dev server
  }
  return { token, allowedOrigins };
}

/** GET /auth/:token — exchanges the printed token for a session cookie. */
export function authExchangeHandler(auth: AuthContext) {
  return (req: Request, res: Response): void => {
    const supplied = String(req.params.token ?? '');
    if (!supplied || !timingSafeEqual(supplied, auth.token)) {
      res.status(401).send('Invalid access token.');
      return;
    }
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(supplied)}; HttpOnly; SameSite=Strict; Path=/`,
    );
    res.redirect('/');
  };
}

/** protects /api/*: valid bearer or session cookie required */
export function apiAuthGate(auth: AuthContext) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const supplied = bearerToken(req) ?? cookieToken(req);
    if (!supplied || !timingSafeEqual(supplied, auth.token)) {
      res.status(401).json({ error: 'Authentication required. Open the access link printed in the server console.', code: 'UNAUTHENTICATED' });
      return;
    }
    // CSRF: when a browser supplies an Origin on a mutating request, it must
    // be one of ours. Non-browser clients (no Origin) proved themselves via
    // the token above.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (typeof origin === 'string' && origin !== 'null' && !auth.allowedOrigins.has(origin)) {
        res.status(403).json({ error: 'Cross-origin request rejected.', code: 'BAD_ORIGIN' });
        return;
      }
    }
    next();
  };
}
