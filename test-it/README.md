# test.it

Paste the contract address of a pump.fun token and pay a small fee in the project's token. test.it ignores price, liquidity and holders and focuses only on the tech: it finds the project's app, backend and source code. Then an AI engineer (Claude, with prompt caching and a hard cost cap per run) **actually tries it**: it uses the app in a real browser, calls its APIs, reads and runs its code, and checks its on-chain claims. It reports whether the tech works, with evidence and screenshots.

**No dependencies**: Node.js 22+ and the browser you already have (Chrome, Edge, Brave or Chromium).

## Run it

**Windows (CMD)**
```cmd
tar -xf test-it.zip
cd test-it
copy .env.example .env
notepad .env
npm start
```

**WSL / Linux / macOS**
```bash
unzip test-it.zip && cd test-it
cp .env.example .env    # add ANTHROPIC_API_KEY
npm start
```

Open **http://localhost:3001**. The chips in the header show whether the AI key and browser were detected.

In `.env`, `ANTHROPIC_API_KEY` is required. `GITHUB_TOKEN` (enables GitHub code search, which finds unlinked repos much better), `SOLANA_RPC_URL` and `BRAVE_API_KEY` are strongly recommended.

> **WSL note:** WSL usually has no browser, so run test.it from Windows CMD. Otherwise, install Chromium in WSL, or run `npx playwright install chromium` there once.

## Deploying

See **[DEPLOY.md](DEPLOY.md)** for free hosting: Render (Fast and Probe) or an Oracle Cloud Always Free VM (all modes), plus the protections to turn on first.

## Modes

| Mode | What happens | Time | AI cost cap |
|---|---|---|---|
| **Fast** | Automated discovery (metadata links, JS bundle scan, GitHub search, homepage in a real browser), then a short AI pass (up to 14 tool calls): open the app once, try the main feature or API, check the key claim. | 1–2 min | $0.30 |
| **Probe** | Also crawls the docs and opens the app pages. Then a full AI test (up to 32 calls): clicks through the app with screenshots, calls the APIs it finds, cross-checks against the underlying protocol, reads the repo and checks on-chain claims. | 3–6 min | $1.00 |
| **Build** | Everything in Probe, plus the project's full source code is downloaded and analyzed without ever being run: size, languages, dependencies, leaked secrets, mock/placeholder code, AI and Solana usage. The AI then reads the code behind each claim with a search-and-read tool (up to 55 calls). | 5–12 min | $2.00 |

The "AI cost cap" is a hard limit on your Claude API spend per run. When a run approaches it, the AI is told to wrap up and must submit its report. Actual cost is usually well under the cap because of prompt caching. Each run's real cost is printed in the server console.

## Pages

- **Test** (`/`): paste a contract address and pick a mode. Already-tested or live tokens are pointed to their report or live test first.
- **Live now** (`/live`): every test running or waiting; click to watch live (`/watch/<CA>?mode=…`).
- **Tested** (`/tested`): every tested token with its latest verdict, searchable.
- **Report page** (`/t/<CA>?mode=…`): a token's saved report with a tab per mode tested, a shareable link and "Test it again".

Results are stored in a free **Upstash Redis** database if `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set. Otherwise they go to local files in `data/`, which Render's free plan wipes on every restart.

## Handling traffic

- **Waiting line:** up to `MAX_CONCURRENT` tests run at once (default 3). Everyone else waits in line and sees their position and an estimated wait, instead of an error.
- **Tested page:** every finished test is saved as that token's latest result. Pasting a token that was already tested points to its report, and "Test it again" replaces it with the new result.
- **Live now page:** every running or waiting test is listed, and anyone can open one and watch it live.
- **Live sharing:** if a token is already being tested, new visitors watch that test live instead of starting another.
- **Fairness:** each visitor can have `MAX_RUNS_PER_VISITOR` tests in progress (default 2), and the line holds up to `MAX_QUEUE` (default 100).
- **One shared browser:** all tests use one Chrome process with an isolated window each, which is what makes 3 tests fit in 512 MB. On a bigger server, raise `MAX_CONCURRENT`.

## Payments

Every test must be paid for before it runs, by default **$0.50 in your project's token**:

1. The user connects a Solana wallet (Phantom, Solflare, Backpack or any Wallet Standard wallet).
2. The server gets the token's live USD price (Jupiter, falling back to DexScreener) and quotes the amount. It checks the wallet has enough and that the pasted address is a real token, so nobody pays to test garbage.
3. The wallet shows one transaction to approve: a transfer of the quoted amount to your `PAYMENT_WALLET`, tagged with a memo unique to that quote.
4. The server confirms it on-chain. It checks the transaction succeeded, was signed by the quoting wallet, carries the right memo, and moved at least the quoted amount of the right token to your treasury. It then issues a one-time credit for that exact token and mode. The same transaction can never be used twice.
5. If a run fails before any paid work starts (for example, a server error), the credit is returned automatically and the user can retry without paying again.

Set `PAYMENT_TOKEN_MINT` and `PAYMENT_WALLET` in `.env`. Until your token launches, set `PAYMENTS_DISABLED=1` to run for free locally. Payment records are kept in `data/payments.json`.

> Price check: at $0.50, a Build run can cost you more in API usage than you earn (up to its $2.00 cap). Consider `PRICE_USD_BUILD=2` or higher.

## How it avoids "unverifiable"

- **It uses the app for real.** The headless browser renders JS-only sites, clicks buttons, types test input, follows "Sign in" to the actual OAuth provider, and records every backend call and response. The AI sees the screenshots.
- **It uses what the JavaScript reveals.** API routes and backend hosts buried in the bundle get called directly, so a login wall doesn't stop the investigation.
- **It checks against ground truth.** If the app wraps another protocol, such as a perps exchange, a DEX or an AI model, the AI compares the app's data with that protocol's own public API. It also verifies claimed programs and wallets on-chain.
- **It hunts for the source.** It searches GitHub repos and code by domain, token address and program IDs, searches the web, and ranks candidate repos. It only attributes a repo to the project with real evidence.
- **Strict verdict rules.** The AI must use `PARTIALLY_WORKS` if anything is confirmed working, and `DOES_NOT_WORK` if the product is a shell. `UNVERIFIABLE` is reserved for projects with truly no evidence either way.

## Safety

- Every request, whether from the server, the AI or the browser page, goes through a guard. Localhost, private networks and cloud-metadata addresses are blocked, including via redirects.
- The browser runs in a throwaway profile with downloads blocked. Its instructions are to never enter credentials, connect wallets, sign or pay.
- Build mode never runs downloaded code: the repository archive is unpacked in memory only (never written to disk or executed), with size limits, and symlinks and dependency folders are ignored.
- Scraped content is treated as untrusted data, never as instructions. The server only listens on `127.0.0.1`.

## Keeping AI costs down

- **Prompt caching:** the instructions, the collected evidence and the growing conversation are cached, so each step re-reads history at 5–10% of the normal price. This was the biggest cost before.
- **Sonnet 5.5 by default** in every mode. Switch a mode to Opus with e.g. `PROBE_MODEL=claude-opus-5-5`.
- Small thinking budgets, fewer tool calls, smaller screenshots, and trimmed page/tool output.
- **Hard per-run cost cap per mode** (see `.env.example`).

## Layout

```
server/
  index.js      HTTP server + SSE endpoint
  runs.js       waiting line and live run sharing
  store.js      saved results for the Tested page (local files or Upstash Redis)
  pipeline.js   the investigation steps
  analyze.js    AI agent loop + tools (http, inspect_asset, browser, github, web_search, solana_rpc, code)
  browser.js    headless Chrome/Edge via DevTools Protocol over a private pipe (no Puppeteer needed)
  code.js       Build mode: download repo archive, analyze in memory, read-only code tool
  github.js     repo inspection, search, candidate ranking
  discover.js   HTML parsing, link classification, JS bundle scanning
  search.js     web search (Brave API or DuckDuckGo)
  solana.js     mint, metadata, read-only RPC
  payments.js   quotes, on-chain payment verification, run credits
  solana-tx.js  builds the payment transaction (no SDK)
  signals.js    automated red/yellow/green checks
  net.js        guarded fetch   ·   b58.js  base58 + PDAs
public/         frontend (wallet.js = Wallet Standard connect + sign)
test/           tests (mocked network, real headless browser)
```
