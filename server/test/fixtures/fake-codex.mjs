// Stand-in for the Codex CLI's `codex exec --json` used by the adapter test.
// Parses -C (workspace) and -o (last-message file), emits plausible JSONL
// events, actually writes a file into the workspace, and writes the final
// message to the -o file — exercising the real evidence + report path.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const valueAfter = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const workspace = valueAfter('-C') ?? process.cwd();
const lastMsgFile = valueAfter('-o');

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// drain the piped prompt from stdin
process.stdin.resume();
process.stdin.on('data', () => {});

emit({ type: 'thread.started', thread_id: 'fake-thread' });
emit({ type: 'item.completed', item: { item_type: 'assistant_message', text: 'Planning: I will create greet.py and run it.' } });

await sleep(300); // stay alive long enough for the pause-rejection assertion

fs.writeFileSync(path.join(workspace, 'greet.py'), 'print("hi from codex")\n', 'utf8');
emit({ type: 'item.completed', item: { item_type: 'file_change', path: 'greet.py' } });
emit({ type: 'item.completed', item: { item_type: 'command_execution', command: 'python greet.py' } });

const finalMessage =
  'Created greet.py and ran it.\n```json\n' +
  JSON.stringify({
    summary: 'Created greet.py that prints a greeting',
    workPerformed: ['Wrote greet.py', 'Ran python greet.py'],
    limitations: [],
    confidence: 0.88,
  }) +
  '\n```';

if (lastMsgFile) fs.writeFileSync(lastMsgFile, finalMessage, 'utf8');
emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20 } });
process.exit(0);
