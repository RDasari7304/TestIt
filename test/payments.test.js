// Payment tests with a mocked Solana RPC + price API (no real money involved).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { b58decode, b58encode } from '../server/b58.js';

process.env.PAYMENTS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'testit-pay-'));
const MINT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'; // payment token (test value)
const TREASURY = 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ';
const PAYER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const TARGET = 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
process.env.PAYMENT_TOKEN_MINT = MINT;
process.env.PAYMENT_WALLET = TREASURY;
delete process.env.PAYMENTS_DISABLED;
delete process.env.PRICE_USD;

const { buildPaymentTx, associatedTokenAddress } = await import('../server/solana-tx.js');
const { createQuote, verifyPayment, consumeCredit, refundCredit, paymentConfig } = await import('../server/payments.js');

let balance = '100000000000'; // 100,000 tokens (6 decimals)
let price = 0.0001; // $0.0001 per token -> $0.50 = 5,000 tokens
const txs = {};
const mintAccount = (decimals) => ({ result: { value: { owner: TOKEN, data: { parsed: { type: 'mint', info: { decimals, supply: '1000000000000000', mintAuthority: null, freezeAuthority: null } } } } } });
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith('https://lite-api.jup.ag/price/v3')) return json({ [MINT]: { usdPrice: price } });
  if (url.includes('api.mainnet-beta.solana.com')) {
    const { method, params } = JSON.parse(init.body);
    if (method === 'getAccountInfo' && (params[0] === MINT || params[0] === TARGET)) return json(mintAccount(6));
    if (method === 'getAccountInfo') return json({ result: { value: null } });
    if (method === 'getTokenAccountBalance') return json({ result: { value: { amount: balance } } });
    if (method === 'getLatestBlockhash') return json({ result: { value: { blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N' } } });
    if (method === 'getTransaction') return json({ result: txs[params[0]] ?? null });
    return json({ error: { message: `unmocked ${method}` } });
  }
  if (url.startsWith('https://ipfs.io/')) return json({});
  throw new Error(`Unmocked fetch ${url}`);
};

// A confirmed transaction as getTransaction(jsonParsed) would return it.
function fakeTx({ memo, amount, payer = PAYER, err = null, owner = TREASURY, mint = MINT }) {
  return {
    blockTime: Math.floor(Date.now() / 1000),
    meta: {
      err,
      preTokenBalances: [{ accountIndex: 2, mint, owner, uiTokenAmount: { amount: '1000' } }],
      postTokenBalances: [{ accountIndex: 2, mint, owner, uiTokenAmount: { amount: String(1000n + BigInt(amount)) } }],
      innerInstructions: [],
    },
    transaction: { message: { accountKeys: [{ pubkey: payer, signer: true }, { pubkey: 'x', signer: false }], instructions: [{ program: 'spl-memo', parsed: memo }] } },
  };
}
const sig = (n) => b58encode(Buffer.alloc(64, n));

beforeEach(() => {
  balance = '100000000000';
  price = 0.0001;
});

test('payment transaction bytes are well-formed', () => {
  const { transaction, payerAta, treasuryAta } = buildPaymentTx({ payer: PAYER, mint: MINT, tokenProgram: TOKEN, treasury: TREASURY, amountRaw: 5_000_000_000n, decimals: 6, memo: 'test.it:abc', blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N' });
  const tx = Buffer.from(transaction, 'base64');
  assert.equal(tx[0], 1, 'one signature slot');
  assert.ok(tx.subarray(1, 65).every((b) => b === 0), 'unsigned');
  const msg = tx.subarray(65);
  assert.deepEqual([...msg.subarray(0, 3)], [1, 0, 6]);
  assert.equal(msg[3], 9, '9 account keys');
  const keys = Array.from({ length: 9 }, (_, i) => b58encode(msg.subarray(4 + i * 32, 36 + i * 32)));
  assert.deepEqual(keys.slice(0, 5), [PAYER, payerAta, treasuryAta, TREASURY, MINT]);
  assert.equal(keys[5], '11111111111111111111111111111111');
  assert.equal(payerAta, associatedTokenAddress(PAYER, MINT, TOKEN));
  let o = 4 + 9 * 32;
  assert.equal(b58encode(msg.subarray(o, o + 32)), 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N');
  o += 32;
  assert.equal(msg[o++], 3, 'three instructions');
  const ixs = [];
  for (let n = 0; n < 3; n++) {
    const program = keys[msg[o++]];
    const na = msg[o++];
    const accounts = [...msg.subarray(o, o + na)].map((i) => keys[i]);
    o += na;
    const dl = msg[o++];
    const data = msg.subarray(o, o + dl);
    o += dl;
    ixs.push({ program, accounts, data });
  }
  assert.equal(o, msg.length, 'no trailing bytes');
  assert.equal(ixs[0].program, 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  assert.deepEqual([...ixs[0].data], [1], 'CreateIdempotent');
  assert.equal(ixs[1].program, TOKEN);
  assert.deepEqual(ixs[1].accounts, [payerAta, MINT, treasuryAta, PAYER]);
  assert.equal(ixs[1].data[0], 12, 'TransferChecked');
  assert.equal(ixs[1].data.readBigUInt64LE(1), 5_000_000_000n);
  assert.equal(ixs[1].data[9], 6);
  assert.equal(ixs[2].data.toString(), 'test.it:abc');
});

test('quote prices $0.50 in tokens and checks the balance', async () => {
  assert.equal(paymentConfig().prices.probe, 0.5);
  const q = await createQuote({ ca: TARGET, mode: 'probe', payer: PAYER });
  assert.equal(q.symbol, 'TOKEN');
  assert.equal(q.amount, '5,000');
  assert.equal(q.usd, 0.5);
  balance = '1000000';
  await assert.rejects(createQuote({ ca: TARGET, mode: 'probe', payer: PAYER }), (e) => e.status === 402 && /You need 5,000/.test(e.message));
  await assert.rejects(createQuote({ ca: 'So11111111111111111111111111111111111111112', mode: 'probe', payer: PAYER }), /not a Solana token/);
  await assert.rejects(createQuote({ ca: TARGET, mode: 'probe', payer: TREASURY }), /treasury/);
});

test('verification: happy path, replay, wrong memo/amount/signer, credits', async () => {
  const q = await createQuote({ ca: TARGET, mode: 'fast', payer: PAYER });
  const memo = `test.it:${q.quoteId}`;

  txs[sig(1)] = fakeTx({ memo: 'test.it:someotherquote', amount: 5_000_000_000n });
  await assert.rejects(verifyPayment({ quoteId: q.quoteId, signature: sig(1) }), /memo/);
  txs[sig(2)] = fakeTx({ memo, amount: 4_000_000_000n });
  await assert.rejects(verifyPayment({ quoteId: q.quoteId, signature: sig(2) }), /full amount/);
  txs[sig(3)] = fakeTx({ memo, amount: 5_000_000_000n, payer: TARGET });
  await assert.rejects(verifyPayment({ quoteId: q.quoteId, signature: sig(3) }), /not signed/);
  txs[sig(4)] = fakeTx({ memo, amount: 5_000_000_000n, owner: PAYER });
  await assert.rejects(verifyPayment({ quoteId: q.quoteId, signature: sig(4) }), /full amount/);
  txs[sig(5)] = fakeTx({ memo, amount: 5_000_000_000n, err: { InstructionError: [1, 'x'] } });
  await assert.rejects(verifyPayment({ quoteId: q.quoteId, signature: sig(5) }), /failed on-chain/);
  await assert.rejects(verifyPayment({ quoteId: q.quoteId, signature: 'notbase58!!' }), /Invalid/);

  txs[sig(6)] = fakeTx({ memo, amount: 5_000_000_000n });
  const { credit } = await verifyPayment({ quoteId: q.quoteId, signature: sig(6) });
  assert.match(credit, /^[0-9a-f]{32}$/);
  assert.deepEqual(await verifyPayment({ quoteId: q.quoteId, signature: sig(6) }), { credit }, 'idempotent for the same quote');

  // Same signature can't pay for a second quote
  const q2 = await createQuote({ ca: TARGET, mode: 'fast', payer: PAYER });
  await assert.rejects(verifyPayment({ quoteId: q2.quoteId, signature: sig(6) }), /already used/);

  // Credits: wrong token/mode rejected, single use, refundable
  assert.throws(() => consumeCredit(credit, TARGET, 'build'), /different token or mode/);
  consumeCredit(credit, TARGET, 'fast');
  assert.throws(() => consumeCredit(credit, TARGET, 'fast'), /already been used/);
  refundCredit(credit);
  consumeCredit(credit, TARGET, 'fast');
  assert.throws(() => consumeCredit('nope', TARGET, 'fast'), /Payment not found/);

  // Persisted to disk
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.PAYMENTS_DATA_DIR, 'payments.json'), 'utf8'));
  assert.ok(saved.usedSignatures[sig(6)]);
  assert.equal(saved.credits[credit].used, true);
});
