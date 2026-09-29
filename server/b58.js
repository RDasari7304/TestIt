// Tiny dependency-free Solana helpers: base58 and program-derived addresses.
import { createHash } from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = Object.fromEntries([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function b58decode(str) {
  let n = 0n;
  for (const c of str) {
    if (!(c in MAP)) throw new Error('Invalid base58 character');
    n = n * 58n + MAP[c];
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of str) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

export function b58encode(buf) {
  let n = BigInt('0x' + (Buffer.from(buf).toString('hex') || '0'));
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function isPubkey(str) {
  try {
    return b58decode(str).length === 32;
  } catch {
    return false;
  }
}

// ed25519 point decompression check: a PDA must NOT be a valid curve point.
const P = 2n ** 255n - 19n;
const mod = (a) => ((a % P) + P) % P;
function pow(b, e) {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
const D = mod(-121665n * pow(121666n, P - 2n));

function isOnCurve(bytes) {
  const b = Buffer.from(bytes);
  const sign = b[31] >> 7;
  b[31] &= 0x7f;
  const y = BigInt('0x' + Buffer.from(b).reverse().toString('hex'));
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  if (u === 0n) return sign === 0; // x = 0
  const x2 = (u * pow(v, P - 2n)) % P;
  return pow(x2, (P - 1n) / 2n) === 1n; // x^2 must be a quadratic residue
}

export function findProgramAddress(seeds, programIdB58) {
  const programId = b58decode(programIdB58);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Buffer.from([bump]));
    h.update(programId);
    h.update(Buffer.from('ProgramDerivedAddress'));
    const digest = h.digest();
    if (!isOnCurve(digest)) return [b58encode(digest), bump];
  }
  throw new Error('Could not find a program address');
}
