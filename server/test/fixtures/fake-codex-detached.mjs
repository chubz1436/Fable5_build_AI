// Stand-in for `codex` that spawns a BACKGROUND (detached) child before doing
// its own work. The background child sleeps, then writes a delayed marker.
//
// Cancellation must terminate the WHOLE process tree — parent AND detached
// descendant — so the delayed marker must never appear. A cancellation that
// only kills the direct child (or the cmd.exe wrapper) would leave this
// descendant alive and the marker would be written.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('codex-cli 9.9.9-detached (fake shim)\n');
  process.exit(0);
}

let brief = '';
let started = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (brief += c));
process.stdin.on('end', run);
process.stdin.resume();

async function run() {
  if (started) return;
  started = true;
  process.stdout.write('fake-codex: session started\n');

  const marker = path.join(process.cwd(), 'DETACHED_CHILD_RAN.txt');
  const childScript = `
    setTimeout(() => {
      try { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'detached child survived cancellation\\n'); } catch {}
      process.exit(0);
    }, 6000);
  `;
  // a background descendant that outlives its parent unless the whole tree dies
  const child = spawn(process.execPath, ['-e', childScript], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  process.stdout.write(`fake-codex: spawned background child pid=${child.pid}\n`);

  // the parent then works "slowly" so there is a cancellation window
  await new Promise((r) => setTimeout(r, 30_000));
  fs.writeFileSync('sum.js', 'module.exports = (a, b) => a + b;\n', 'utf8');
  process.stdout.write('fake-codex: wrote sum.js\n');
  process.exit(0);
}
