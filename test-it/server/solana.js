// On-chain facts about the mint: authorities, supply, holder concentration and
// the token's metadata (Metaplex account, Token-2022 metadata extension, or DAS).
import { b58decode, b58encode, isPubkey, findProgramAddress } from './b58.js';
import { safeFetch } from './net.js';

const RPC = () => process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidSolanaAddress(s) {
  return B58.test(s) && isPubkey(s);
}

export async function rpc(method, params, signal) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.any([AbortSignal.timeout(25000), ...(signal ? [signal] : [])]),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      continue;
    }
    if (res.status === 429) throw new Error(`Solana RPC rate-limited (${method}); set SOLANA_RPC_URL to a private RPC (a free Helius key works)`);
    if (!res.ok) throw new Error(`Solana RPC ${method} HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(`Solana RPC ${method}: ${j.error.message}`);
    return j.result;
  }
}

// Read-only methods Claude may call to check claimed on-chain activity.
export const READ_ONLY_METHODS = [
  'getAccountInfo', 'getBalance', 'getSignaturesForAddress', 'getTransaction', 'getTokenAccountsByOwner',
  'getTokenAccountBalance', 'getTokenLargestAccounts', 'getTokenSupply', 'getMultipleAccounts', 'getProgramAccounts',
  'getSlot', 'getBlockTime', 'getAsset', 'getAssetsByOwner', 'searchAssets',
];

export async function readOnlyRpc(method, params, signal) {
  if (!READ_ONLY_METHODS.includes(method)) throw new Error(`Method ${method} is not allowed`);
  if (method === 'getProgramAccounts') {
    // Unfiltered program scans are huge and usually rejected; require filters and a data slice.
    const cfg = params?.[1] || {};
    if (!cfg.filters?.length) throw new Error('getProgramAccounts requires filters');
    params = [params[0], { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, ...cfg }];
  }
  return rpc(method, params, signal);
}

export async function getMintInfo(ca, signal) {
  const res = await rpc('getAccountInfo', [ca, { encoding: 'jsonParsed' }], signal);
  if (!res?.value) return { exists: false };
  const v = res.value;
  const isMint = (v.owner === TOKEN_PROGRAM || v.owner === TOKEN_2022) && v.data?.parsed?.type === 'mint';
  if (!isMint) return { exists: true, isMint: false, owner: v.owner };
  const info = v.data.parsed.info;
  const extensions = info.extensions || [];
  return {
    exists: true,
    isMint: true,
    program: v.owner === TOKEN_2022 ? 'Token-2022' : 'SPL Token',
    decimals: info.decimals,
    supply: info.supply,
    uiSupply: Number(info.supply) / 10 ** info.decimals,
    mintAuthority: info.mintAuthority || null,
    freezeAuthority: info.freezeAuthority || null,
    extensions: extensions.map((e) => e.extension),
    tokenMetadataExt: extensions.find((e) => e.extension === 'tokenMetadata')?.state || null,
  };
}

function readBorshString(buf, offset) {
  const len = buf.readUInt32LE(offset);
  const value = buf.subarray(offset + 4, offset + 4 + len).toString('utf8').replace(/\0/g, '').trim();
  return [value, offset + 4 + len];
}

async function metaplexMetadata(ca, signal) {
  const [pda] = findProgramAddress([Buffer.from('metadata'), b58decode(METAPLEX), b58decode(ca)], METAPLEX);
  const res = await rpc('getAccountInfo', [pda, { encoding: 'base64' }], signal);
  if (!res?.value) return null;
  const buf = Buffer.from(res.value.data[0], 'base64');
  let o = 1;
  const updateAuthority = b58encode(buf.subarray(o, o + 32));
  o += 64; // update authority + mint
  const [name, o2] = readBorshString(buf, o);
  const [symbol, o3] = readBorshString(buf, o2);
  const [uri] = readBorshString(buf, o3);
  return { source: 'metaplex', name, symbol, uri, updateAuthority };
}

async function dasAsset(ca, signal) {
  try {
    const a = await rpc('getAsset', { id: ca }, signal);
    const md = a?.content?.metadata || {};
    return { source: 'das', name: md.name, symbol: md.symbol, description: md.description, uri: a?.content?.json_uri, links: a?.content?.links };
  } catch {
    return null; // public RPC doesn't support DAS; that's fine
  }
}

function ipfsToHttp(uri) {
  if (uri.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${uri.slice(7).replace(/^ipfs\//, '')}`;
  if (uri.startsWith('ar://')) return `https://arweave.net/${uri.slice(5)}`;
  return uri;
}

export async function getOnchainMetadata(ca, mint, signal) {
  let meta = null;
  if (mint.tokenMetadataExt) {
    const s = mint.tokenMetadataExt;
    meta = { source: 'token-2022', name: s.name, symbol: s.symbol, uri: s.uri, additional: s.additionalMetadata };
  }
  if (!meta) meta = await metaplexMetadata(ca, signal).catch(() => null);
  if (!meta || !meta.uri) {
    const das = await dasAsset(ca, signal);
    if (das) meta = { ...das, ...Object.fromEntries(Object.entries(meta || {}).filter(([, v]) => v)) };
  }
  if (!meta) return { source: 'none' };
  if (meta.uri) {
    try {
      const r = await safeFetch(ipfsToHttp(meta.uri), { signal, maxBytes: 300_000, timeoutMs: 12000 });
      meta.json = JSON.parse(r.text);
      meta.description = meta.description || meta.json.description;
    } catch (e) {
      meta.jsonError = `Could not load metadata JSON: ${e.message}`;
    }
  }
  if (meta.json?.image) delete meta.json.image_data;
  return meta;
}
