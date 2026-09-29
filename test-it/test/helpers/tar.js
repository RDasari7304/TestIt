// Test helper: builds GitHub-style .tar.gz archives in memory.
import zlib from 'node:zlib';

// Minimal tar writer (ustar + pax long names), like GitHub's tarballs.
function header(name, size, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0);
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = (buf) => Buffer.concat([buf, Buffer.alloc((512 - (buf.length % 512)) % 512)]);
export function tarGz(entries) {
  const parts = [header('pax_global_header', 52, 'g'), pad(Buffer.from('52 comment=abc123abc123abc123abc123abc123abc123ab\n'))];
  for (const [name, content, type] of entries) {
    const body = Buffer.from(content);
    if (name.length > 100) {
      const rec = ` path=${name}\n`;
      let len = rec.length + 2;
      len = String(len + String(len).length - 2).length + rec.length;
      const pax = Buffer.from(`${len}${rec}`);
      parts.push(header('PaxHeader', pax.length, 'x'), pad(pax));
    }
    parts.push(header(name, type === '2' ? 0 : body.length, type || '0'));
    if (type !== '2') parts.push(pad(body));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

export const TOP = 'agentx-core-abc123/';
export const longPath = `${TOP}packages/${'very-long-folder-name/'.repeat(6)}agent.ts`;
export const ARCHIVE = tarGz([
  [`${TOP}README.md`, '# AgentX\nAutonomous trading agents.\n'],
  [`${TOP}package.json`, JSON.stringify({ name: 'agentx', scripts: { build: 'tsc' }, dependencies: { openai: '^4', '@solana/web3.js': '^1' } })],
  [`${TOP}src/agent.ts`, 'import OpenAI from "openai";\nexport async function decide(p){\n  // TODO: real strategy\n  return mockDecision(p);\n}\nconst key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD";\n'],
  [`${TOP}programs/agent/src/lib.rs`, 'use anchor_lang::prelude::*;\ndeclare_id!("Ag3ntPrograM1111111111111111111111111111111");\n'],
  [`${TOP}node_modules/evil/index.js`, 'should be skipped'],
  [`${TOP}assets/logo.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])],
  [`${TOP}link-to-etc`, '', '2'],
  [longPath, 'export const x = 1;\n'],
]);

