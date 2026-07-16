// Stand-in for the Claude Code CLI used by the adapter integration test.
// Emits the same stream-json event shapes and actually writes a file into
// the workspace (cwd) so evidence diffing is exercised for real.
import fs from 'node:fs';

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// drain stdin (the adapter pipes the prompt in); we don't need its content
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => {});

emit({ type: 'system', subtype: 'init', model: 'fake-model', session_id: 'fake-session' });
emit({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'Reading the brief and creating the file now.' }] },
});

await sleep(300); // keep the process alive long enough for pause-rejection asserts

fs.writeFileSync('hello.txt', 'hello from fake claude\nsecond line\n', 'utf8');
emit({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'hello.txt' } }] },
});

emit({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 2,
  total_cost_usd: 0.0123,
  result:
    'Done.\n```json\n{"summary": "Created hello.txt", "workPerformed": ["Wrote hello.txt"], "limitations": [], "confidence": 0.9}\n```',
});
