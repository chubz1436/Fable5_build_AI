import { createApp, createContext } from './app';
import { enableRealAdapters } from './engine/engine';

const ctx = createContext();
const app = createApp(ctx);

if (ctx.config.realAdapters) {
  void enableRealAdapters(ctx.store, ctx.config).catch((err) =>
    console.error('real-adapter detection failed:', err),
  );
}

const server = app.listen(ctx.config.port, () => {
  console.log(`\n  CHUBZ AI Command Center`);
  console.log(`  API + UI : http://localhost:${ctx.config.port}`);
  console.log(`  Data file: ${ctx.config.dataFile}`);
  console.log(`  Sim speed: ${ctx.config.simSpeed}x\n`);
});

function shutdown() {
  ctx.store.flushSync();
  server.close(() => process.exit(0));
  // don't hang forever on open SSE connections
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => ctx.store.flushSync());
