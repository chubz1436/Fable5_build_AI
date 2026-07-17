// Stand-in for the npm-installed `codex` CLI, launched through a real
// Windows .cmd shim (or a POSIX shell shim) so the tests exercise the actual
// resolve → spawn → stdin path.
//
//   <shim> --version           → prints a version line, exit 0
//   <shim> exec … -            → reads the brief from STDIN (never argv),
//                                writes sum.js into cwd, exit 0
//   brief contains [[SLOW]]    → sleeps 30s first (cancellation window)
//
// The task text only ever arrives on stdin; argv is fixed. If any injected
// shell metacharacters in the brief were (wrongly) executed, this script
// would never be the thing writing files — so the injection test asserts the
// injected side-effect file is absent while sum.js is present.
import fs from 'node:fs';

const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('codex-cli 9.9.9-fake (fake shim)\n');
  process.exit(0);
}

let brief = '';
let done = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (brief += c));
process.stdin.on('end', run);
process.stdin.resume();

async function run() {
  if (done) return;
  done = true;
  process.stdout.write('fake-codex: session started\n');
  if (brief.includes('[[MENTION_AUTH]]')) {
    // a successful session that merely MENTIONS auth/quota in its reasoning
    process.stdout.write('reasoning: no authentication or quota problems; 401/429 not applicable.\n');
  }
  if (brief.includes('[[SLOW]]')) {
    await new Promise((r) => setTimeout(r, 30_000));
  }
  // a real file change in the worktree (cwd): a tiny addition utility
  fs.writeFileSync('sum.js', 'module.exports = (a, b) => a + b;\n', 'utf8');
  process.stdout.write(`fake-codex: wrote sum.js (brief ${brief.length} chars)\n`);
  process.exit(0);
}
