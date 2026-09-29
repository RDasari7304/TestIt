// Pay-per-run: each test costs a USD amount (default $0.50) paid in the
// project's own token. Flow:
//   POST /api/quote        -> price the run in tokens, check the payer's balance,
//                             return an unsigned transfer tx + quote id
//   (wallet signs & sends)
//   POST /api/pay/verify   -> confirm on-chain: success, right mint, right amount
//                             to the treasury, memo matches, signed by the payer,
//                             signature never used before -> single-use run credit
//   GET  /api/analyze?credit=...  consumes the credit (refunded if the run fails
//                             before any paid work starts)
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { rpc, getMintInfo, getOnchainMetadata, isValidSolanaAddress } from './solana.js';
import { buildPaymentTx, associatedTokenAddress } from './solana-tx.js';
import { b58decode } from './b58.js';

const DATA_DIR = process.env.PAYMENTS_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const STORE = path.join(DATA_DIR, 'payments.json');
const QUOTE_TTL_MS = 10 * 60 * 1000;

let store = { quotes: {}, credits: {}, usedSignatures: {} };
try {
  store = { ...store, ...JSON.parse(fs.readFileSync(STORE, 'utf8')) };
} catch {}
function save() {
  // Drop stale quotes so the file stays small.
  const now = Date.now();
  for (const [id, q] of Object.entries(store.quotes)) if (!q.paid && now - q.createdAt > QUOTE_TTL_MS * 3) delete store.quotes[id];
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE + '.tmp', JSON.stringify(store, null, 1));
  fs.renameSync(STORE + '.tmp', STORE);
}

export function paymentConfig() {
  const e = process.env;
  const disabled = e.PAYMENTS_DISABLED === '1';
  const mint = e.PAYMENT_TOKEN_MINT || null;
  const treasury = e.PAYMENT_WALLET || null;
  const base = Number(e.PRICE_USD ?? 0.5);
  return {
    enabled: !disabled,
    configured: Boolean(mint && treasury && isValidSolanaAddress(mint) && isValidSolanaAddress(treasury)),
    mint,
    treasury,
    prices: {
      fast: Number(e.PRICE_USD_FAST ?? base),
      probe: Number(e.PRICE_USD_PROBE ?? base),
      build: Number(e.PRICE_USD_BUILD ?? base),
    },
  };
}

class PayError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export { PayError };

// ---- payment token info + price (cached) ----
let tokenCache = null;
export async function paymentToken(signal) {
  const cfg = paymentConfig();
  if (!cfg.configured) return null;
  if (tokenCache?.mint === cfg.mint && Date.now() - tokenCache.at < 3600_000) return tokenCache;
  const mint = await getMintInfo(cfg.mint, signal);
  if (!mint.isMint) throw new PayError('PAYMENT_TOKEN_MINT is not a token mint', 500);
  const meta = await getOnchainMetadata(cfg.mint, mint, signal).catch(() => ({}));
  tokenCache = {
    mint: cfg.mint,
    decimals: mint.decimals,
    tokenProgram: mint.program === 'Token-2022' ? 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' : 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    symbol: meta?.symbol || meta?.json?.symbol || 'TOKEN',
    name: meta?.name || meta?.json?.name || null,
    at: Date.now(),
  };
  return tokenCache;
}

let priceCache = { at: 0, usd: null };
export async function tokenPriceUsd(mint, signal) {
  if (priceCache.mint === mint && Date.now() - priceCache.at < 60_000 && priceCache.usd) return priceCache.usd;
  const sig = () => AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]);
  let usd = null;
  try {
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`, { signal: sig(), headers: { accept: 'application/json' } });
    if (r.ok) usd = Number((await r.json())?.[mint]?.usdPrice) || null;
  } catch {}
  if (!usd) {
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: sig(), headers: { accept: 'application/json' } });
      const pairs = ((await r.json()).pairs || []).filter((p) => p.chainId === 'solana' && p.baseToken?.address === mint && Number(p.priceUsd) > 0);
      pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      usd = Number(pairs[0]?.priceUsd) || null;
    } catch {}
  }
  if (!usd) throw new PayError('Could not get a live price for the payment token right now. Try again in a minute.', 503);
  priceCache = { mint, usd, at: Date.now() };
  return usd;
}

// ---- quotes ----
export async function createQuote({ ca, mode, payer }, signal) {
  const cfg = paymentConfig();
  if (!cfg.configured) throw new PayError('Payments are not configured on this server (PAYMENT_TOKEN_MINT / PAYMENT_WALLET).', 503);
  if (!['fast', 'probe', 'build'].includes(mode)) throw new PayError('Unknown mode');
  if (!isValidSolanaAddress(ca)) throw new PayError('That is not a valid Solana address.');
  if (!isValidSolanaAddress(payer)) throw new PayError('Invalid wallet address.');
  if (payer === cfg.treasury) throw new PayError('The treasury wallet cannot pay itself.');

  // Don't let people pay for something that can't be tested.
  const target = await getMintInfo(ca, signal);
  if (!target.exists || !target.isMint) throw new PayError('That address is not a Solana token, so there is nothing to test.');

  const token = await paymentToken(signal);
  const usd = cfg.prices[mode];
  const price = await tokenPriceUsd(token.mint, signal);
  const amountRaw = BigInt(Math.ceil((usd / price) * 10 ** token.decimals));
  if (amountRaw <= 0n) throw new PayError('Price calculation failed', 500);

  const payerAta = associatedTokenAddress(payer, token.mint, token.tokenProgram);
  let balanceRaw = 0n;
  try {
    const b = await rpc('getTokenAccountBalance', [payerAta, { commitment: 'confirmed' }], signal);
    balanceRaw = BigInt(b?.value?.amount || '0');
  } catch {
    balanceRaw = 0n; // account doesn't exist
  }
  const fmt = (raw) => (Number(raw) / 10 ** token.decimals).toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (balanceRaw < amountRaw) {
    throw new PayError(`You need ${fmt(amountRaw)} $${token.symbol} (≈ $${usd.toFixed(2)}) but this wallet has ${fmt(balanceRaw)}.`, 402);
  }

  const id = randomBytes(8).toString('hex');
  const { value } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }], signal);
  const memo = `test.it:${id}`;
  const { transaction, treasuryAta } = buildPaymentTx({
    payer, mint: token.mint, tokenProgram: token.tokenProgram, treasury: cfg.treasury,
    amountRaw, decimals: token.decimals, memo, blockhash: value.blockhash,
  });
  const quote = {
    id, ca, mode, payer, usd, priceUsd: price, amountRaw: amountRaw.toString(), decimals: token.decimals,
    mint: token.mint, treasury: cfg.treasury, treasuryAta, memo, createdAt: Date.now(), expiresAt: Date.now() + QUOTE_TTL_MS, paid: false,
  };
  store.quotes[id] = quote;
  save();
  return {
    quoteId: id,
    transaction,
    amount: fmt(amountRaw),
    symbol: token.symbol,
    usd,
    priceUsd: price,
    expiresAt: quote.expiresAt,
  };
}

// ---- verification ----
function memoFrom(tx) {
  const all = [...(tx.transaction?.message?.instructions || []), ...(tx.meta?.innerInstructions || []).flatMap((i) => i.instructions)];
  return all.filter((i) => i.program === 'spl-memo' || i.programId === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr').map((i) => (typeof i.parsed === 'string' ? i.parsed : ''));
}

export async function verifyPayment({ quoteId, signature }, signal) {
  const q = store.quotes[quoteId];
  if (!q) throw new PayError('Unknown or expired quote. Start again.', 404);
  if (q.paid) return { credit: q.credit };
  let sigBytes;
  try {
    sigBytes = b58decode(String(signature));
  } catch {
    throw new PayError('Invalid transaction signature');
  }
  if (sigBytes.length !== 64) throw new PayError('Invalid transaction signature');
  if (store.usedSignatures[signature]) throw new PayError('This payment was already used.', 409);

  // Wait for confirmation (up to ~60s).
  let tx = null;
  for (let i = 0; i < 30 && !tx; i++) {
    tx = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }], signal).catch(() => null);
    if (!tx) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!tx) throw new PayError('Payment not confirmed yet. If your wallet shows it succeeded, click "Check payment again".', 408);
  if (tx.meta?.err) throw new PayError('The payment transaction failed on-chain.', 402);
  if (tx.blockTime && tx.blockTime * 1000 > q.expiresAt + 5 * 60 * 1000) throw new PayError('This quote expired before the payment landed. Start again.', 410);

  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? { pubkey: k, signer: false } : k));
  if (!keys.some((k) => k.pubkey === q.payer && k.signer)) throw new PayError('Payment was not signed by the quoted wallet.', 402);
  if (!memoFrom(tx).some((m) => m.includes(q.memo))) throw new PayError('Payment memo does not match this quote.', 402);

  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];
  const toTreasury = post.filter((b) => b.mint === q.mint && b.owner === q.treasury);
  let received = 0n;
  for (const b of toTreasury) {
    const before = pre.find((p) => p.accountIndex === b.accountIndex);
    received += BigInt(b.uiTokenAmount.amount) - BigInt(before?.uiTokenAmount?.amount || '0');
  }
  if (received < BigInt(q.amountRaw)) throw new PayError('The treasury did not receive the full amount.', 402);

  const credit = randomBytes(16).toString('hex');
  store.usedSignatures[signature] = { quoteId, at: Date.now() };
  store.credits[credit] = { ca: q.ca, mode: q.mode, quoteId, signature, payer: q.payer, usd: q.usd, createdAt: Date.now(), used: false };
  q.paid = true;
  q.signature = signature;
  q.credit = credit;
  save();
  return { credit };
}

// ---- credits ----
export function consumeCredit(creditId, ca, mode) {
  const c = store.credits[creditId];
  if (!c) throw new PayError('Payment not found. Pay to run a test.', 402);
  if (c.used) throw new PayError('This payment has already been used for a test.', 409);
  if (c.ca !== ca || c.mode !== mode) throw new PayError('This payment was for a different token or mode.', 409);
  c.used = true;
  c.usedAt = Date.now();
  save();
  return c;
}

export function refundCredit(creditId) {
  const c = store.credits[creditId];
  if (!c) return;
  c.used = false;
  c.refunds = (c.refunds || 0) + 1;
  save();
}
