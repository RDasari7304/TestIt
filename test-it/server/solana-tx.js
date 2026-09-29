// Builds the payment transaction (unsigned) without any Solana SDK:
//   1. create the treasury's token account if it doesn't exist (idempotent)
//   2. TransferChecked of the quoted amount from the payer to the treasury
//   3. Memo "test.it:<quoteId>" so the payment is tied to one quote
// The payer's wallet signs and sends it; the server then verifies it on-chain.
import { b58decode, findProgramAddress } from './b58.js';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export function associatedTokenAddress(owner, mint, tokenProgram) {
  return findProgramAddress([b58decode(owner), b58decode(tokenProgram), b58decode(mint)], ATA_PROGRAM)[0];
}

function compactU16(n) {
  const out = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      break;
    }
    out.push(b | 0x80);
  }
  return Buffer.from(out);
}

function u64le(value) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

export function buildPaymentTx({ payer, mint, tokenProgram, treasury, amountRaw, decimals, memo, blockhash }) {
  const payerAta = associatedTokenAddress(payer, mint, tokenProgram);
  const treasuryAta = associatedTokenAddress(treasury, mint, tokenProgram);
  // Account order: writable signers | writable non-signers | read-only non-signers
  const keys = [payer, payerAta, treasuryAta, treasury, mint, SYSTEM_PROGRAM, tokenProgram, ATA_PROGRAM, MEMO_PROGRAM];
  const idx = Object.fromEntries(keys.map((k, i) => [k, i]));
  if (Object.keys(idx).length !== keys.length) throw new Error('Payer cannot be the treasury');
  const header = Buffer.from([1, 0, 6]);

  const ix = (programId, accounts, data) => Buffer.concat([
    Buffer.from([idx[programId]]),
    compactU16(accounts.length),
    Buffer.from(accounts.map((a) => idx[a])),
    compactU16(data.length),
    data,
  ]);
  const instructions = [
    ix(ATA_PROGRAM, [payer, treasuryAta, treasury, mint, SYSTEM_PROGRAM, tokenProgram], Buffer.from([1])), // CreateIdempotent
    ix(tokenProgram, [payerAta, mint, treasuryAta, payer], Buffer.concat([Buffer.from([12]), u64le(amountRaw), Buffer.from([decimals])])), // TransferChecked
    ix(MEMO_PROGRAM, [], Buffer.from(memo, 'utf8')),
  ];

  const message = Buffer.concat([
    header,
    compactU16(keys.length),
    ...keys.map((k) => b58decode(k)),
    b58decode(blockhash),
    compactU16(instructions.length),
    ...instructions,
  ]);
  const tx = Buffer.concat([compactU16(1), Buffer.alloc(64), message]);
  return { transaction: tx.toString('base64'), payerAta, treasuryAta, message };
}
