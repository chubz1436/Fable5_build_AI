// Stand-in for the Antigravity CLI (`agy --print`) used by the adapter test.
// agy prints a PLAIN-TEXT response; it operates on the process cwd (the
// adapter sets cwd = workspace). This fake writes a real file into cwd and
// prints plain text lines ending with the fenced json block the brief asks
// for — exercising the real evidence + report path.
import fs from 'node:fs';

// stdin is ignored by the adapter (stdio 'ignore'); nothing to drain.

const say = (s) => process.stdout.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

say('Reading _TASK_BRIEF.md and planning the change.');
await sleep(300); // stay alive long enough for the pause-rejection assertion

fs.writeFileSync('notes.md', '# Notes\n\n- created by antigravity\n', 'utf8');
say('Created notes.md in the workspace.');

say('done');
say('```json');
say(
  JSON.stringify({
    summary: 'Created notes.md with a short heading and bullet',
    workPerformed: ['Wrote notes.md'],
    limitations: [],
    confidence: 0.86,
  }),
);
say('```');
process.exit(0);
