# Deploying test.it for free

There are two free options. Both run all three modes (Fast, Probe and Build).

| | **A. Render (free plan)** | **B. Oracle Cloud Always Free VM** |
|---|---|---|
| Setup time | ~10 minutes | ~45 minutes |
| Resources | 512 MB RAM, sleeps after 15 min idle (~1 min cold start) | Up to 4 ARM cores + 24 GB RAM, always on |
| URL | `https://test-it-xxxx.onrender.com` | your own (free DuckDNS subdomain) |
| Card needed | No | Yes (identity check only, not charged on Always Free) |

Start with **A**. Move to **B** if you outgrow Render's free limits (512 MB RAM, sleeping when idle).

---

## Before either option

### 1. Set a spend limit on your Anthropic account
The site is free and open to everyone, so set a monthly spend limit in the Anthropic Console (console.anthropic.com → Limits). Each run is also capped per mode ($0.30 / $1.00 / $2.00).

### 2. Rotate the API key you pasted in chat
Create a fresh key in the Console and use only the new one in production.

### 3. Push the code to GitHub (private repo)
From the `test-it` folder:
```bash
git init
git add .
git commit -m "test.it"
```
On github.com click **New repository**, name it `test-it`, choose **Private**, and create it. Then:
```bash
git remote add origin https://github.com/<your-username>/test-it.git
git branch -M main
git push -u origin main
```
`.env`, `data/` and `reports/` are in `.gitignore`, so your keys are never pushed. Check with `git status` before the first commit.

---

## Option A: Render (free)

1. Sign in at **render.com** with GitHub.
2. Click **New → Blueprint**, pick your `test-it` repo, and click **Apply**. Render reads `render.yaml` and creates a free Docker web service.
3. When asked for environment variables, fill in:
   - `ANTHROPIC_API_KEY`: your **new** key
   - `GITHUB_TOKEN`: recommended
   - `SOLANA_RPC_URL`: recommended
4. Wait for the first build (~5 minutes; it installs Chromium). Open the `onrender.com` URL.

Every `git push` to `main` redeploys automatically.

Notes:
- Free instances sleep after 15 minutes without visitors. The first visit after that takes about a minute.
- The disk resets on each deploy or restart (saved reports are lost; the live report in the browser is unaffected).
- 512 MB fits one test at a time (`MAX_CONCURRENT=1` is set). Heavy websites can occasionally crash the browser; the report then says the browser was unavailable.

---

## Option B: Oracle Cloud Always Free VM (always on, more memory)

### 1. Create the VM
1. Sign up at **cloud.oracle.com**. Pick a home region close to you; it can't be changed later.
2. Go to **Compute → Instances → Create instance**.
   - Image: **Ubuntu 24.04**
   - Shape: **Ampere (VM.Standard.A1.Flex)**, 2 OCPU / 12 GB RAM (free up to 4 / 24)
   - Add your SSH public key (or let Oracle generate one and download it)
   - If the shape shows "out of capacity", try another availability domain or try again later.
3. Open the web ports: click the instance's **Subnet → Default Security List → Add Ingress Rules**. Source `0.0.0.0/0`, TCP, destination ports **80,443**.

### 2. Set up the server
SSH in with `ssh ubuntu@<public-ip>`, then:
```bash
# Ubuntu images on Oracle also block ports with iptables:
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save

# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Headless Chromium for browser testing
npx -y playwright install --with-deps chromium

# Get the code (use a GitHub personal access token as the password for a private repo)
git clone https://github.com/<your-username>/test-it.git
cd test-it
cp .env.example .env
nano .env     # set ANTHROPIC_API_KEY, GITHUB_TOKEN, SOLANA_RPC_URL
```

### 3. Run it as a service
```bash
sudo cp deploy/test-it.service /etc/systemd/system/
sudo systemctl enable --now test-it
sudo journalctl -u test-it -f      # view logs (Ctrl+C to exit)
```

### 4. Free domain + HTTPS
1. At **duckdns.org**, sign in and create a subdomain (e.g. `testit-rohit`) pointing to your VM's public IP.
2. Install Caddy and set it up:
```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile     # replace yourname.duckdns.org with your subdomain
sudo systemctl reload caddy
```
Open `https://<your-subdomain>.duckdns.org`.

### Updating later
```bash
cd ~/test-it && git pull && sudo systemctl restart test-it
```


---

## Turning payments on later
Once your token is live, in `.env` (or Render's Environment tab):
1. Remove `PAYMENTS_DISABLED=1`.
2. Set `PAYMENT_TOKEN_MINT` and `PAYMENT_WALLET`.
3. Optionally set per-mode prices like `PRICE_USD_BUILD=2`.

On Render, payment records live on a disk that resets. Before real money flows, move to option B, or add a Render persistent disk (paid) mounted at `/app/data`.
