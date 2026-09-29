// Minimal Wallet Standard client (Phantom, Solflare, Backpack, etc.), no SDK.
// Wallets register themselves via window events; we only need connect +
// solana:signAndSendTransaction, which takes raw transaction bytes.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

const wallets = [];
const listeners = new Set();
const api = {
  register(...ws) {
    for (const w of ws) {
      const solana = w.chains?.some((c) => c.startsWith('solana:')) && w.features?.['standard:connect'] && w.features?.['solana:signAndSendTransaction'];
      if (solana && !wallets.includes(w)) wallets.push(w);
    }
    listeners.forEach((fn) => fn(wallets));
    return () => {};
  },
};
window.addEventListener('wallet-standard:register-wallet', (e) => {
  try {
    e.detail(api);
  } catch {}
});
window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));

export const getWallets = () => wallets;
export const onWallets = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export async function connect(wallet) {
  const { accounts } = await wallet.features['standard:connect'].connect();
  const account = (accounts || wallet.accounts).find((a) => a.chains?.some((c) => c.startsWith('solana:'))) || (accounts || wallet.accounts)[0];
  if (!account) throw new Error('The wallet did not share an account');
  return { wallet, account, address: account.address };
}

export async function disconnect(wallet) {
  try {
    await wallet.features['standard:disconnect']?.disconnect();
  } catch {}
}

export async function signAndSend({ wallet, account }, base64Tx) {
  const bytes = Uint8Array.from(atob(base64Tx), (c) => c.charCodeAt(0));
  const [result] = await wallet.features['solana:signAndSendTransaction'].signAndSendTransaction({
    account,
    chain: 'solana:mainnet',
    transaction: bytes,
    options: { preflightCommitment: 'confirmed' },
  });
  return b58encode(result.signature);
}
