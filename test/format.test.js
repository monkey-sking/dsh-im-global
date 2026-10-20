import test from 'node:test';
import assert from 'node:assert/strict';

import { formatFor, splitMessage, toPreview, renderTable, escapeMentions } from '../lib/format.js';

test('a pipe table becomes a monospace block', () => {
  const md = '| 项 | 值 |\n|---|---|\n| a | 1 |\n| 中文 | 2 |';
  const out = formatFor(md, 'discord');
  assert.match(out, /^```\n/);
  assert.match(out, /项\s+\| 值/);
  assert.match(out, /中文 \| 2/);
  assert.match(out, /```$/);
  assert.doesNotMatch(out, /\|---\|/);
});

test('headings and bullets are rendered, not left raw', () => {
  const out = formatFor('## 标题\n\n- 一\n- 二', 'discord');
  assert.match(out, /\*\*标题\*\*/);
  assert.match(out, /• 一/);
  assert.doesNotMatch(out, /##/);
});

test('slack uses single-asterisk bold', () => {
  const out = formatFor('**粗体**', 'slack');
  assert.equal(out, '*粗体*');
});

test('mass mentions are neutralized', () => {
  assert.match(escapeMentions('@everyone hi', 'discord'), /@\u200beveryone/);
  assert.match(escapeMentions('<!channel> hi', 'slack'), /\u200b!channel/);
  assert.match(escapeMentions('@room 开会', 'matrix'), /@\u200broom/);
});

test('fenced code is preserved verbatim', () => {
  const out = formatFor('```bash\necho "# not a heading"\n```', 'discord');
  assert.match(out, /echo "# not a heading"/);
  assert.doesNotMatch(out, /\*\*not a heading\*\*/);
});

test('long text splits under the platform limit', () => {
  const text = Array.from({ length: 40 }, (_, i) => `第 ${i} 行`.repeat(6)).join('\n');
  const chunks = splitMessage(text, 200);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 200);
  assert.equal(chunks.join('\n').replace(/\n+/g, '\n').length > 0, true);
});

test('preview never cuts a surrogate pair', () => {
  const text = 'a'.repeat(1799) + '🥚' + 'b'.repeat(10);
  const out = toPreview(text, 1800);
  assert.ok(!/[\uD800-\uDBFF]$/.test(out.replace(/\n…$/, '')));
});

test('renderTable aligns CJK columns by display width', () => {
  const out = renderTable(['| 名 | 值 |', '|---|---|', '| 短 | 1 |', '| 很长很长 | 22 |']);
  // Compare only the first column: the last cell is intentionally unpadded.
  const firstCells = out
    .split('\n')
    .slice(1, -1)
    .map((row) => row.split('|')[0]);
  const width = (cell) => [...cell].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
  assert.deepEqual(new Set(firstCells.map(width)).size, 1, `ragged: ${JSON.stringify(firstCells)}`);
});
