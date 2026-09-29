// Headless browser for actually trying the product, with zero dependencies.
// Drives the Chrome / Edge / Chromium already installed on the machine over the
// Chrome DevTools Protocol over a private pipe. Every request the
// page makes is checked by the same public-host guard as safeFetch.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertPublicUrl } from './net.js';

const W = 1280;
const H = 900;

function candidates() {
  const list = [];
  if (process.env.CHROME_PATH) list.push(process.env.CHROME_PATH);
  if (process.platform === 'win32') {
    const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    list.push(
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${local}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`
    );
  } else if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
    );
  } else {
    for (const dir of (process.env.PATH || '').split(':')) {
      for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']) {
        list.push(path.join(dir, n));
      }
    }
    // Playwright-installed browsers (npx playwright install chromium)
    const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), '.cache', 'ms-playwright')].filter(Boolean);
    for (const root of roots) {
      try {
        for (const d of fs.readdirSync(root).sort().reverse()) {
          if (d.startsWith('chromium-')) list.push(path.join(root, d, 'chrome-linux', 'chrome'), path.join(root, d, 'chrome-linux64', 'chrome'));
        }
      } catch {}
    }
  }
  return list;
}

export function findBrowser() {
  if (process.env.TESTIT_NO_BROWSER === '1') return null;
  return candidates().find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }) || null;
}

const READ_PAGE = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.title || el.name || el.alt || '').trim().replace(/\\s+/g, ' ').slice(0, 90);
  document.querySelectorAll('[data-testit]').forEach((e) => e.removeAttribute('data-testit'));
  const els = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), textarea, select, [role=button], [role=tab], [role=link], [role=menuitem], [contenteditable=true], summary')].filter(vis).slice(0, 90);
  const controls = els.map((el, i) => { el.setAttribute('data-testit', String(i)); return { i, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || undefined, text: label(el), href: el.href || undefined, disabled: el.disabled || undefined }; });
  const text = (document.body ? document.body.innerText : '').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { url: location.href, title: document.title, text: text.slice(0, 7000), textChars: text.length, controls };
})()`;

const FIND_EL = (target) => `(() => {
  const t = ${JSON.stringify(String(target))};
  let el = null;
  if (/^\\d+$/.test(t)) el = document.querySelector('[data-testit="' + t + '"]');
  if (!el) { try { el = document.querySelector(t); } catch {} }
  if (!el) {
    const low = t.toLowerCase();
    const all = [...document.querySelectorAll('button, a, input, textarea, select, [role=button], [role=tab], [role=link], [role=menuitem], label, summary, [contenteditable=true], div, span')];
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
    const txt = (e) => (e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').trim().toLowerCase();
    el = all.find((e) => vis(e) && txt(e) === low) || all.find((e) => vis(e) && txt(e).includes(low) && txt(e).length < low.length + 40);
  }
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  window.__testitEl = el;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 80) };
})()`;

export class BrowserSession {
  constructor() {
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.network = [];
    this.console = [];
    this.blocked = [];
    this.popups = [];
    this.inflight = new Set();
    this.hostCache = new Map();
    this.lastActivity = Date.now();
    this.screenshots = [];
  }

  static async launch({ signal } = {}) {
    const exe = findBrowser();
    if (!exe) throw new Error('No Chrome, Edge or Chromium found (set CHROME_PATH in .env)');
    const s = new BrowserSession();
    s.exe = exe;
    s.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testit-browser-'));
    // --remote-debugging-pipe: the browser is controlled over private pipes
    // (fd 3/4), never a TCP port, so nothing else on the machine can drive it.
    const args = [
      '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${s.dir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
      '--disable-background-networking', '--disable-default-apps', '--disable-component-update',
      '--mute-audio', '--hide-scrollbars', `--window-size=${W},${H}`, '--password-store=basic',
      '--use-mock-keychain', '--disable-features=Translate,MediaRouter,OptimizationHints', 'about:blank',
    ];
    if (process.platform === 'linux') args.push('--disable-dev-shm-usage', '--disable-gpu');
    if ((process.platform === 'linux' && process.getuid?.() === 0) || process.env.CHROME_NO_SANDBOX === '1') args.push('--no-sandbox');
    if (process.env.TESTIT_BROWSER_ARGS) args.push(...process.env.TESTIT_BROWSER_ARGS.split(/\s+(?=--)/).filter(Boolean)); // used by tests
    // The browser gets a minimal environment: no API keys or other secrets.
    const env = {};
    for (const k of ['PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'DISPLAY', 'FONTCONFIG_PATH', 'XDG_RUNTIME_DIR', 'windir', 'ComSpec']) {
      if (process.env[k]) env[k] = process.env[k];
    }
    s.proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], env });
    let stderr = '';
    s.proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    s.proc.on('exit', () => {
      s.dead = true;
      for (const p of s.pending.values()) p.reject(new Error('Browser exited'));
      s.pending.clear();
    });
    s.proc.on('error', () => (s.dead = true));
    s.connectPipe(s.proc.stdio[3], s.proc.stdio[4]);
    try {
      await Promise.race([
        s.send('Browser.getVersion', {}, null, 20000),
        new Promise((_, rej) => signal?.addEventListener('abort', () => rej(new Error('Cancelled')), { once: true })),
      ]);
    } catch (e) {
      s.close();
      throw new Error(s.dead ? `Browser exited on start: ${stderr.slice(-300)}` : `Browser did not start: ${e.message}`);
    }
    await s.setup();
    return s;
  }

  connectPipe(writable, readable) {
    this.out = writable;
    this.out.on('error', () => {});
    let buf = '';
    readable.setEncoding('utf8');
    readable.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\0')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        let m;
        try {
          m = JSON.parse(raw);
        } catch {
          continue;
        }
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
        } else if (m.method) {
          for (const fn of this.listeners) fn(m);
        }
      }
    });
  }

  send(method, params = {}, session = this.session, timeoutMs = 30000) {
    if (this.dead || !this.out || this.out.destroyed) return Promise.reject(new Error('Browser is not running'));
    const id = ++this.id;
    const msg = { id, method, params };
    if (session) msg.sessionId = session;
    this.out.write(JSON.stringify(msg) + '\0');
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Browser command ${method} timed out`));
        }
      }, timeoutMs);
    });
  }

  waitFor(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const off = () => this.listeners.delete(fn);
      const fn = (m) => {
        if (m.method === method && m.sessionId === this.session) {
          off();
          resolve(m.params);
        }
      };
      this.listeners.add(fn);
      setTimeout(() => {
        off();
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
    });
  }

  async isAllowed(url) {
    if (/^(data|blob|about|chrome|devtools|chrome-extension):/i.test(url)) return true;
    if (/^wss?:/i.test(url)) url = url.replace(/^ws/i, 'http');
    let host;
    try {
      host = new URL(url).host;
    } catch {
      return false;
    }
    if (!this.hostCache.has(host)) this.hostCache.set(host, assertPublicUrl(url).then(() => true, () => false));
    return this.hostCache.get(host);
  }

  async setup() {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' }, null);
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, null);
    this.session = sessionId;
    this.targetId = targetId;

    this.listeners.add(async (m) => {
      const p = m.params || {};
      if (m.method === 'Target.targetCreated' && p.targetInfo?.type === 'page' && p.targetInfo.targetId !== this.targetId && p.targetInfo.openerId) {
        this.popups.push(p.targetInfo.url);
        this.send('Target.closeTarget', { targetId: p.targetInfo.targetId }, null).catch(() => {});
        return;
      }
      if (m.method === 'Target.targetInfoChanged' && p.targetInfo?.openerId && p.targetInfo.url && p.targetInfo.url !== 'about:blank') {
        this.popups.push(p.targetInfo.url);
        return;
      }
      if (m.sessionId !== this.session) return;
      if (m.method === 'Fetch.requestPaused') {
        const ok = await this.isAllowed(p.request.url);
        if (ok) this.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
        else {
          this.blocked.push(p.request.url);
          this.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
        }
      } else if (m.method === 'Network.requestWillBeSent') {
        this.inflight.add(p.requestId);
        this.lastActivity = Date.now();
        if (['XHR', 'Fetch', 'WebSocket', 'EventSource', 'Document', 'Other'].includes(p.type) || !p.type) {
          this.network.push({ id: p.requestId, method: p.request.method, url: p.request.url, type: p.type, postData: p.request.postData?.slice(0, 400) });
          if (this.network.length > 300) this.network.shift();
        }
      } else if (m.method === 'Network.responseReceived') {
        const r = this.network.find((x) => x.id === p.requestId);
        if (r) {
          r.status = p.response.status;
          r.mime = p.response.mimeType;
        }
      } else if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') {
        this.inflight.delete(p.requestId);
        this.lastActivity = Date.now();
        if (m.method === 'Network.loadingFailed') {
          const r = this.network.find((x) => x.id === p.requestId);
          if (r) r.failed = p.errorText;
        }
      } else if (m.method === 'Network.webSocketCreated') {
        this.network.push({ id: p.requestId, method: 'WS', url: p.url, type: 'WebSocket' });
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.console.push(`exception: ${(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '').slice(0, 300)}`);
      } else if (m.method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'warning')) {
        this.console.push(`${p.type}: ${p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
      } else if (m.method === 'Page.javascriptDialogOpening') {
        this.console.push(`dialog: ${p.message?.slice(0, 200)}`);
        this.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
      }
      if (this.console.length > 60) this.console.shift();
    });

    await this.send('Target.setDiscoverTargets', { discover: true }, null);
    await this.send('Browser.setDownloadBehavior', { behavior: 'deny' }, null).catch(() => {});
    await Promise.all([
      this.send('Page.enable'),
      this.send('Runtime.enable'),
      this.send('Network.enable', { maxResourceBufferSize: 2_000_000, maxTotalBufferSize: 20_000_000 }),
      this.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }),
      this.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }),
    ]);
  }

  async settle(maxMs = 7000, quietMs = 900) {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 300));
    while (Date.now() - start < maxMs) {
      if (this.inflight.size <= 1 && Date.now() - this.lastActivity > quietMs) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    this.inflight.clear();
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  mark() {
    return { net: this.network.length, con: this.console.length, pop: this.popups.length, blk: this.blocked.length };
  }

  since(m) {
    const calls = this.network.slice(m.net).filter((r) => r.type !== 'Document' || r.status >= 300);
    return {
      apiCalls: calls.filter((r) => ['XHR', 'Fetch', 'WebSocket', 'EventSource'].includes(r.type) || r.method !== 'GET').slice(-25).map(({ id, ...r }) => r),
      consoleErrors: this.console.slice(m.con).slice(-10),
      popupsOpened: this.popups.slice(m.pop),
      blockedRequests: this.blocked.slice(m.blk).slice(-5),
    };
  }

  async open(url) {
    await assertPublicUrl(url);
    const m = this.mark();
    const loaded = this.waitFor('Page.loadEventFired', 25000).catch(() => null);
    const nav = await this.send('Page.navigate', { url });
    if (nav.errorText) return { error: `Navigation failed: ${nav.errorText}` };
    await loaded;
    await this.settle(8000);
    const page = await this.read();
    const main = this.network.slice(m.net).find((r) => r.type === 'Document');
    return { status: main?.status, ...page, ...this.since(m) };
  }

  async read() {
    return this.evaluate(READ_PAGE);
  }

  async click(target) {
    const m = this.mark();
    const el = await this.evaluate(FIND_EL(target));
    if (!el) return { error: `No visible element matching "${target}". Use action "read" to list controls.` };
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: el.x, y: el.y, button: 'left', clickCount: 1 });
    }
    await this.settle(6000);
    const page = await this.read();
    return { clicked: `${el.tag} "${el.text}"`, url: page.url, title: page.title, text: page.text.slice(0, 4000), controls: page.controls, ...this.since(m) };
  }

  async type(target, text, submit) {
    const m = this.mark();
    const el = await this.evaluate(FIND_EL(target));
    if (!el) return { error: `No visible element matching "${target}"` };
    await this.evaluate(`(() => { const e = window.__testitEl; e.focus(); if ('value' in e) { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'value'); d && d.set ? d.set.call(e, '') : (e.value = ''); e.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
    await this.send('Input.insertText', { text: String(text).slice(0, 2000) });
    if (submit) await this.press('Enter', false);
    await this.settle(6000);
    const page = await this.read();
    return { typedInto: `${el.tag} "${el.text}"`, url: page.url, text: page.text.slice(0, 4000), controls: page.controls, ...this.since(m) };
  }

  async press(key, settle = true) {
    const codes = { Enter: 13, Tab: 9, Escape: 27, ArrowDown: 40, ArrowUp: 38, Backspace: 8 };
    const base = { key, code: key, windowsVirtualKeyCode: codes[key] || 0 };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(key === 'Enter' ? { text: '\r' } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    if (settle) {
      await this.settle(5000);
      return this.read();
    }
  }

  async scroll(dir = 'down') {
    await this.evaluate(`window.scrollBy(0, ${dir === 'up' ? -1 : 1} * window.innerHeight * 0.9)`);
    await this.settle(2500, 500);
    return this.read();
  }

  async back() {
    await this.evaluate('history.back()');
    await this.settle(5000);
    return this.read();
  }

  async screenshot(label = '') {
    const r = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: 55, clip: { x: 0, y: 0, width: W, height: H, scale: 0.6 } });
    const url = await this.evaluate('location.href').catch(() => '');
    const shot = { data: r.data, url, label, at: new Date().toISOString() };
    if (this.screenshots.length < 14) this.screenshots.push(shot);
    return shot;
  }

  async responseBodies(limit = 8) {
    const calls = this.network.filter((r) => ['XHR', 'Fetch'].includes(r.type) && r.status).slice(-limit);
    const out = [];
    for (const c of calls) {
      try {
        const b = await this.send('Network.getResponseBody', { requestId: c.id }, this.session, 5000);
        const body = b.base64Encoded ? '[binary]' : b.body;
        out.push({ method: c.method, url: c.url, status: c.status, body: body.slice(0, 900) });
      } catch {
        out.push({ method: c.method, url: c.url, status: c.status, body: '[body unavailable]' });
      }
    }
    return out;
  }

  close() {
    try {
      this.out?.end();
    } catch {}
    try {
      this.proc?.kill();
    } catch {}
    setTimeout(() => fs.rm(this.dir, { recursive: true, force: true, maxRetries: 3 }, () => {}), 1500);
  }
}
