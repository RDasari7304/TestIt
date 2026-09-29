// Outbound HTTP for fetching project sites and letting Claude test endpoints.
// Everything goes through safeFetch: public http(s) hosts only (no localhost /
// private ranges / cloud metadata), manual redirect handling with re-checks,
// timeouts and a response size cap.
import dns from 'node:dns/promises';
import net from 'node:net';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 test.it/1.0';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

export async function assertPublicUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) URLs are allowed');
  if (url.username || url.password) throw new Error('URLs with credentials are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error(`Blocked non-public host: ${host}`);
  }
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error(`Blocked non-public host: ${host}`);
  }
  return url;
}

async function readLimited(res, maxBytes) {
  if (!res.body) return { text: '', truncated: false, bytes: 0 };
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - bytes));
      bytes = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    bytes += value.length;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated, bytes };
}

export async function safeFetch(
  input,
  { method = 'GET', headers = {}, body, timeoutMs = 15000, maxBytes = 1_500_000, signal } = {}
) {
  let current = input;
  const started = Date.now();
  const redirects = [];
  for (let hop = 0; hop < 6; hop++) {
    const url = await assertPublicUrl(current);
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'user-agent': UA, accept: '*/*', ...headers },
        body,
        redirect: 'manual',
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      const reason = e.name === 'TimeoutError' ? `timed out after ${timeoutMs / 1000}s` : e.cause?.code || e.message;
      throw new Error(`Request to ${url.hostname} failed: ${reason}`);
    }
    const location = res.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(res.status) && location) {
      redirects.push(url.toString());
      current = new URL(location, url).toString();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      await res.body?.cancel().catch(() => {});
      continue;
    }
    const { text, truncated, bytes } = method === 'HEAD' ? { text: '', truncated: false, bytes: 0 } : await readLimited(res, maxBytes);
    return {
      url: url.toString(),
      redirects,
      status: res.status,
      ok: res.ok,
      contentType: res.headers.get('content-type') || '',
      ms: Date.now() - started,
      text,
      truncated,
      bytes,
    };
  }
  throw new Error('Too many redirects');
}
