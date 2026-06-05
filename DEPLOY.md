# Deploying AIO-Survey on a DigitalOcean Droplet

This app stores all data in a **SQLite file** (`data/responses.db`). On Vercel
that file was wiped on every redeploy because Vercel's filesystem is ephemeral.
A **Droplet** is a real virtual machine with a persistent disk, so the database
survives restarts and redeploys.

The admin dashboard (`/admin`) and its APIs require a password set via the
`ADMIN_PASSWORD` environment variable — **the app refuses to start without it.**

Interview audio recordings are stored next to the database (in `data/audio/`),
so they persist exactly like the survey data. Transcription is optional and uses
**Deepgram**: set a `DEEPGRAM_API_KEY` to enable the "Generate transcript" button
in the dashboard. Without it, recording still works — you just can't auto-transcribe.

---

## Option A — Docker (recommended)

### 1. Create the Droplet
- DigitalOcean → **Create → Droplet**.
- Image: **Ubuntu 24.04 LTS**. Plan: the cheapest Basic (~$6/mo) is plenty.
- Add your **SSH key**, create, then connect:
  ```bash
  ssh root@YOUR_DROPLET_IP
  ```

### 2. Install Docker + Compose
```bash
apt update && apt install -y docker.io docker-compose-plugin
systemctl enable --now docker
```

### 3. Get the code and set the password
```bash
git clone https://github.com/<your-user>/AIO-Survey.git
cd AIO-Survey
printf 'ADMIN_PASSWORD=choose-a-strong-password\n' > .env
# Optional: enable interview transcription
printf 'DEEPGRAM_API_KEY=your-deepgram-key\n' >> .env
```

### 4. Build and run
```bash
docker compose up -d --build
```
The site is now on `http://YOUR_DROPLET_IP:3000`. Data is stored in the
`aio-data` Docker volume and persists across rebuilds.

### 5. Redeploying after code changes
```bash
git pull
docker compose up -d --build
```
The `aio-data` volume is untouched, so **all survey/EQA data is preserved.**

---

## Option B — No Docker (Node + PM2)

```bash
# Install Node 20 + build tools (better-sqlite3 compiles a native module)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs build-essential git
npm install -g pm2

git clone https://github.com/<your-user>/AIO-Survey.git
cd AIO-Survey
npm ci

# Run it, keep it alive, start on boot
ADMIN_PASSWORD='choose-a-strong-password' pm2 start server.js --name aio-survey
pm2 save
pm2 startup   # run the command it prints
```
Here `data/responses.db` lives on the Droplet's disk and persists naturally.
Update with `git pull && npm ci && pm2 restart aio-survey`.

---

## Recommended: HTTPS + a domain

Serving on `:3000` over plain HTTP is fine for testing. For a real URL, put a
reverse proxy in front with automatic HTTPS. **Caddy** is the simplest:

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```
Then `/etc/caddy/Caddyfile`:
```
your-domain.com {
    reverse_proxy localhost:3000
}
```
`systemctl reload caddy`. Point your domain's A record at the Droplet IP and
Caddy fetches a Let's Encrypt certificate automatically. Once proxied, close
port 3000 to the public with `ufw`:
```bash
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
```

---

## Backups (recommended)

The data is only as safe as the Droplet disk. A simple nightly backup via cron:
```bash
# crontab -e
0 2 * * * sqlite3 /root/AIO-Survey/data/responses.db ".backup '/root/backup-$(date +\%F).db'"
```
For off-box safety, enable DigitalOcean's weekly Droplet **Backups** (a checkbox
when creating the Droplet, ~20% of Droplet cost), or sync the backup file to DO
Spaces.
