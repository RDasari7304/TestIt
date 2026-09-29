// Build mode: in-memory source download + analysis + the read-only code tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTarGz, analyzeCode, codeTool } from '../server/code.js';

import { ARCHIVE, TOP, longPath } from './helpers/tar.js';

test('archive is parsed in memory: long names, skipped folders, no symlinks, binaries flagged', () => {
  const a = parseTarGz(ARCHIVE);
  const names = [...a.files.keys()];
  assert.ok(names.includes('README.md'));
  assert.ok(names.includes('src/agent.ts'));
  assert.ok(names.includes(longPath.slice(TOP.length)), 'pax long path');
  assert.ok(!names.some((n) => n.includes('node_modules')), 'node_modules skipped');
  assert.ok(!names.includes('link-to-etc'), 'symlinks ignored');
  assert.equal(a.files.get('assets/logo.png').text, null, 'binary has no text');
});

test('analysis finds languages, deps, secrets, placeholders, AI and Solana usage', () => {
  const inv = analyzeCode(parseTarGz(ARCHIVE), { ca: 'Ag3ntPrograM1111111111111111111111111111111' });
  assert.ok(inv.languages.TypeScript);
  assert.ok(inv.languages.Rust);
  assert.deepEqual(inv.secrets.map((s) => [s.kind, s.file]), [['OpenAI key', 'src/agent.ts']]);
  assert.ok(inv.placeholderHits >= 2, 'TODO + mockDecision');
  assert.ok(inv.ai.OpenAI);
  assert.ok(inv.solana['Anchor (Rust)']);
  assert.deepEqual(inv.programIds, ['Ag3ntPrograM1111111111111111111111111111111']);
  assert.deepEqual(inv.packages[0].notableDeps.sort(), ['@solana/web3.js', 'openai']);
  assert.equal(inv.binaryFiles, 1);
});

test('code tool: tree, grep, read', () => {
  const a = parseTarGz(ARCHIVE);
  assert.deepEqual(codeTool(a, { action: 'tree', pattern: '**/*.rs' }).files, ['programs/agent/src/lib.rs (89B)']);
  const g = codeTool(a, { action: 'grep', pattern: 'mockDecision|declare_id' });
  assert.equal(g.matches, 2);
  assert.ok(g.results.some((r) => r.startsWith('src/agent.ts:4:')));
  const r = codeTool(a, { action: 'read', path: 'src/agent.ts', start_line: 3, line_count: 2 });
  assert.equal(r.content, '3:   // TODO: real strategy\n4:   return mockDecision(p);');
  assert.match(codeTool(a, { action: 'read', path: 'nope.ts' }).error, /No such file/);
  assert.match(codeTool(a, { action: 'grep', pattern: '(' }).results.length >= 0 ? 'ok' : '', /ok/, 'bad regex does not throw');
});

