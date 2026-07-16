import { createApp, createContext } from './app';
import { isLoopback } from './config';
import { enableRealAdapters } from './engine/engine';

const ctx = createContext();

// P0.1: refuse non-loopback binding unless the owner explicitly configured a
// token via the environment — never expose the Command Center to the LAN by
// accident.
if (!isLoopback(ctx.config.host) && !process.env.AUTH_TOKEN) {
  console.error(
    `Refusing to bind to non-loopback host "${ctx.config.host}" without an explicit AUTH_TOKEN. ` +
      'Set HOST=127.0.0.1 (default) or configure AUTH_TOKEN to accept the risk.',
  );
  process.exit(1);
}

const app = createApp(ctx);

if (ctx.config.realAdapters) {
  void enableRealAdapters(ctx.store, ctx.config).catch((err) =>
    console.error('real-adapter detection failed:', err),
  );
}

const server = app.listen(ctx.config.port, ctx.config.host, () => {
  console.log(`\n  CHUBZ AI Command Center`);
  console.log(`  Bound to : http://${ctx.config.host}:${ctx.config.port} (loopback only)`);
  console.log(`  Sign-in  : http://${ctx.config.host}:${ctx.config.port}/auth/${ctx.authToken}`);
  console.log(`  Database : ${ctx.config.dbFile}`);
  console.log(`  Runner   : ${ctx.config.attemptRunner} · sim speed ${ctx.config.simSpeed}x\n`);
});

function shutdown() {
  ctx.store.flushSync();
  ctx.store.close();
  server.close(() => process.exit(0));
  // don't hang forever on open SSE connections
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
