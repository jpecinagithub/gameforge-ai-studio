# Installing GameForge AI Studio on Oracle Cloud (Linux)

**Read this first — the security warning in plain language:**

This backend has **no login screen by design** (it's your personal studio; accounts
would only add attack surface). That is safe **only if the API is reachable
exclusively by you**. If the API were exposed to the public internet, anyone
could use your server as a free AI code-execution service — generating games,
running code in containers, and burning your Cloudflare Workers AI budget — all billed to you.

**So: the recommended setup below keeps the API off the public internet
entirely**, using Tailscale (a private VPN mesh). Your browser talks to the
server over the VPN; the public internet sees nothing. This guide walks you
through it slowly, one numbered step at a time.

How to use this guide: each step first explains **what the commands do**, then
gives you a **paste-ready block**. Paste the whole block, press Enter, wait for
it to finish, then move to the next step. You never need a text editor — every
file is written with `printf`/heredoc commands. Nothing here asks for your
Cloudflare token in chat: you will paste it **directly into a file on the server**
(Step 6), where it stays.

**What you'll have at the end:** Docker running the API, worker, runner,
Postgres, Redis and Caddy on your Oracle VM; the studio reachable at a private
`https://…ts.net` address from your devices; daily backups; a smoke test proving
it works.

---

## Step 0 — What you need before starting

- Your Oracle Cloud VM (Oracle Linux 8 or 9) with SSH access.
- A Tailscale account (free for personal use). Your laptop/phone will join the
  same tailnet so they can reach the server privately.

No domain purchase is needed: Tailscale gives the server a private
`machine-name.your-tailnet.ts.net` address with automatic HTTPS.

---

## Step 1 — Update the system and install Docker

**What this does:** refreshes the OS package list, installs basic tools
(`curl`, `git`), adds Docker's official repository, and installs the Docker
engine plus the Compose plugin. (Oracle Linux is RHEL-compatible, so Docker's
CentOS/RHEL repository works.)

```bash
sudo dnf -y update
sudo dnf -y install curl git openssl
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
docker --version
docker compose version
```

Expected: both commands print version numbers, no errors.

---

## Step 2 — Install Tailscale (the private network)

**What this does:** installs Tailscale and joins this server to your private
tailnet. After this, only your devices can reach the server's private address.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

The second command prints a login URL — open it in your browser once and
approve the machine. Then confirm:

```bash
tailscale status
tailscale ip -4
```

Note the machine's tailnet name, e.g. `oracle-vm.taila1b2c3.ts.net`. You will
use it as `GF_DOMAIN` in Step 6. (Find it any time with `tailscale status`.)

**On your laptop/phone:** install Tailscale from https://tailscale.com/download
and log in with the same account. Your devices can now reach the server
privately.

---

## Step 3 — Firewall: keep SSH, add nothing public

**What this does:** Oracle Linux runs `firewalld`. We make sure SSH stays
reachable and we do **not** open ports 80/443 to the world — with Tailscale,
nothing needs to be public.

```bash
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --reload
sudo firewall-cmd --list-all
```

Expected: `services: ssh` (and possibly `cockpit`, `dhcpv6-client` — that's fine).
No `http`/`https` service — that's intentional.

> If you later choose the public-domain path instead of Tailscale, you would
> add `--add-service={http,https}` here **and** put an IP allowlist or client
> certificate in front of the API (see "Going public" at the end). Don't skip
> that section if you go public.

---

## Step 4 — Clone the repository

**What this does:** downloads the GameForge source code to your home directory.

```bash
cd ~
git clone https://github.com/jpecinagithub/gameforge-ai-studio.git
cd gameforge-ai-studio
git log --oneline -3
```

> If the repo is private, GitHub will ask for credentials. Use a personal
> access token as the password when prompted (paste it at the prompt — it is
> not stored by these commands).

---

## Step 5 — Create the storage directory (locked down)

**What this does:** creates `/var/lib/gameforge` — where project git repos,
uploads, artifacts and backups live — owned by you and readable by nobody else
(mode `0700`). The API, worker and runner containers mount this directory.

```bash
sudo mkdir -p /var/lib/gameforge
sudo chown "$USER:$USER" /var/lib/gameforge
sudo chmod 0700 /var/lib/gameforge
ls -ld /var/lib/gameforge
```

Expected: `drwx------ … /var/lib/gameforge`.

---

## Step 6 — Create the `.env` file (secrets live here, and only here)

**What this does:** creates `infra/deploy/.env` from the template and fills in
your values. This file is **never committed to git** and never leaves the
server. Secrets are generated or pasted:

- `POSTGRES_PASSWORD` — generated randomly by the command below.
- `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` — **you paste them here, on
  the server, now.** They are never typed into chat, never committed, never
  put in the frontend.
- `DATABASE_URL` / `REDIS_URL` — built from the values above (internal
  container hostnames `postgres` and `redis`).

**First, create the Cloudflare API token** (in your browser, on the Cloudflare
dashboard — this is the only step that happens outside the server):

1. Go to dash.cloudflare.com → **My Profile** (top-right avatar) → **API Tokens**.
2. **Create Token** → find the **Workers AI** template (or create a custom token
   with permission **Account → Workers AI → Read** on your account).
3. Copy the token it shows you **once** — keep the tab open, you'll paste it on
   the server in a moment.
4. Copy your **Account ID**: it's in the dashboard URL
   (`dash.cloudflare.com/<ACCOUNT_ID>/...`) or under **Workers & Pages →
   Overview** (right sidebar).

**Now, on the server, generate the Postgres password and write the base file**
(replace `oracle-vm.taila1b2c3.ts.net` with your real tailnet name from Step 2):

```bash
cd ~/gameforge-ai-studio/infra/deploy
PG_PASS="$(openssl rand -hex 24)"
cat > .env << EOF
GF_DOMAIN=oracle-vm.taila1b2c3.ts.net
GF_ACME_EMAIL=you@example.com
ALLOWED_ORIGINS=https://oracle-vm.taila1b2c3.ts.net
POSTGRES_USER=gameforge
POSTGRES_PASSWORD=${PG_PASS}
POSTGRES_DB=gameforge
DATABASE_URL=postgres://gameforge:${PG_PASS}@postgres:5432/gameforge
REDIS_URL=redis://redis:6379
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ACCOUNT_ID=
STORAGE_ROOT=/var/lib/gameforge
RUNNER_WORK_ROOT=/var/lib/gameforge/work
RUNNER_LOG_ROOT=/var/lib/gameforge/runner-logs
EOF
chmod 600 .env
echo "written (Cloudflare credentials still empty)"
```

**Now paste your Cloudflare token into the file** — this fills the
`CLOUDFLARE_API_TOKEN=` line without ever showing the token on screen:

```bash
read -rsp "Paste CLOUDFLARE_API_TOKEN (input hidden), then Enter: " K && echo && \
sed -i "s|^CLOUDFLARE_API_TOKEN=.*|CLOUDFLARE_API_TOKEN=${K}|" .env && unset K && \
grep -c "^CLOUDFLARE_API_TOKEN=." .env && echo "token stored (value not shown)"
```

Then the Account ID (not secret — visible input is fine):

```bash
read -rp "Paste CLOUDFLARE_ACCOUNT_ID, then Enter: " A && \
sed -i "s|^CLOUDFLARE_ACCOUNT_ID=.*|CLOUDFLARE_ACCOUNT_ID=${A}|" .env && unset A && \
grep -c "^CLOUDFLARE_ACCOUNT_ID=[0-9a-f]\{32\}$" .env && echo "account id stored"
```

Expected: `1` followed by "token stored" / "account id stored". The token is
now only in `infra/deploy/.env` (mode 600) on this server. The API registers
it with the secret redactor at boot, so it never appears in logs.

> Without Cloudflare credentials the studio still runs: project/file/asset/build
> features work, but agent runs and the semantic visual review stay unavailable
> (the review is labeled "unverified" instead of faking it). You can add them
> later and restart the API.

---

## Step 7 — Start everything

**What this does:** builds the API/worker/runner images and starts all six
services (reverse-proxy, api, worker, runner, postgres, redis). The API
automatically applies the database migrations on first boot.

```bash
cd ~/gameforge-ai-studio/infra/deploy
docker compose up --build -d
docker compose ps
```

Wait ~30 seconds, then check the API applied its migrations and is healthy:

```bash
docker compose logs api --tail=30 | grep -iE "migrat|listening|error" | head -10
curl -sk https://$(grep GF_DOMAIN .env | cut -d= -f2)/api/v1/health
```

Expected: the `curl` prints JSON like `{"status":"ok",…}`. (`-k` is only needed
until Caddy has its certificate; after ~1 minute the cert is issued and you can
drop `-k`.)

Run this from your **laptop** (Tailscale connected) to prove the private path
works end-to-end:

```bash
curl https://YOUR_TAILNET_NAME.ts.net/api/v1/health
```

Replace with your real tailnet name. A JSON `{"status":"ok"}` means the whole
chain — Tailscale → Caddy (TLS) → API — is live.

---

## Step 8 — Make Docker start on boot

**What this does:** enables the Docker service at boot. The containers
themselves have `restart: unless-stopped`, so the studio survives a VM reboot
with no further action. (Step 1 already ran `systemctl enable --now docker`;
this just double-checks.)

```bash
sudo systemctl is-enabled docker
```

Expected: `enabled`.

---

## Step 9 — Backups (daily, automatic)

**What this does:** creates a backup script (database dump + storage archive)
and schedules it every night at 03:00 server time. Backups land in
`~/backups/` (also mode 700).

```bash
mkdir -p ~/backups && chmod 700 ~/backups
cat > ~/backups/backup-gameforge.sh << 'EOF'
#!/bin/bash
set -euo pipefail
cd ~/gameforge-ai-studio/infra/deploy
DAY="$(date +%F)"
# 1. Database dump (compressed)
docker compose exec -T postgres pg_dump -U gameforge gameforge | gzip > ~/backups/gameforge-db-${DAY}.sql.gz
# 2. Storage (project repos, uploads, artifacts)
tar -czf ~/backups/gameforge-storage-${DAY}.tar.gz -C /var/lib/gameforge .
# 3. Keep the last 14 days only
find ~/backups -name 'gameforge-*' -mtime +14 -delete
echo "backup ${DAY} done: $(ls -lh ~/backups/gameforge-db-${DAY}.sql.gz | awk '{print $5}')"
EOF
chmod +x ~/backups/backup-gameforge.sh
# Schedule it: every day at 03:00
(crontab -l 2>/dev/null; echo "0 3 * * * ~/backups/backup-gameforge.sh >> ~/backups/backup.log 2>&1") | crontab -
crontab -l | grep gameforge
```

Run it once now to prove it works:

```bash
~/backups/backup-gameforge.sh
ls -lh ~/backups/
```

Expected: two fresh archives listed.

### Restore drill (practice this once, so it's boring when it matters)

**What this does:** stops the app, restores the database from a dump, and
restarts. Your project files live in `/var/lib/gameforge` (restored from the
storage tarball if ever lost — the drill below covers the database; for a full
disaster you'd also re-extract the storage archive).

```bash
cd ~/gameforge-ai-studio/infra/deploy
DAY=YYYY-MM-DD   # <-- put the backup date you want, e.g. 2026-10-09
docker compose stop api worker
gunzip -c ~/backups/gameforge-db-${DAY}.sql.gz | docker compose exec -T postgres psql -U gameforge -d gameforge
docker compose start api worker
curl -s https://$(grep GF_DOMAIN .env | cut -d= -f2)/api/v1/health
```

Expected: final `curl` returns `{"status":"ok"}` again. (The `psql` restore
prints `CREATE`/`ALTER` lines; errors like "already exists" on a re-restore are
harmless.)

---

## Step 10 — Smoke test: the studio really works

**What this does:** exercises the API the way the frontend will — create a
project, list it, check the model registry — all over the private HTTPS path.

```bash
BASE="https://$(grep GF_DOMAIN ~/gameforge-ai-studio/infra/deploy/.env | cut -d= -f2)"
# 1. Create a project from the third-person template
curl -s -X POST "$BASE/api/v1/projects" -H 'content-type: application/json' \
  -d '{"name":"smoke test","template":"third-person"}' | head -c 300; echo
# 2. List projects
curl -s "$BASE/api/v1/projects" | head -c 200; echo
# 3. Models discovered at startup (empty until Cloudflare credentials are set + reachable)
curl -s "$BASE/api/v1/models" | head -c 200; echo
```

Expected: each prints JSON (a project object, a project list, a model list).
Then open `https://YOUR_TAILNET_NAME.ts.net` in your laptop browser (Tailscale
on), create a game from the dashboard, and watch the agents work. The preview
iframe serves from `preview.YOUR_TAILNET_NAME.ts.net` automatically.

---

## Step 11 — Updating to a new version later

**What this does:** pulls the latest code, rebuilds the images, and restarts
with zero config changes (your `.env` and `/var/lib/gameforge` are untouched).

```bash
cd ~/gameforge-ai-studio
git pull
cd infra/deploy
docker compose up --build -d
docker compose logs api --tail=5 | grep -iE "migrat|listening"
```

Migrations are additive and idempotent — re-running them on an existing
database is safe.

---

## Step 12 — Machine facts for the Blender adapter (do this once, paste the output back)

The Blender plugin adapter was deliberately **not** shipped blind: it needs the
real OS, CPU architecture and RAM of this server. Run this and send the output
back to the agent:

```bash
echo "=== OS ==="; grep PRETTY_NAME /etc/os-release
echo "=== arch ==="; uname -m
echo "=== CPU ==="; nproc; lscpu | grep "Model name" | head -1
echo "=== RAM ==="; free -h | head -2
echo "=== disk ==="; df -h /var/lib/gameforge | tail -1
echo "=== docker ==="; docker --version
```

---

## Going public (only if you insist — read the warning at the top first)

If you ever want the studio reachable without Tailscale, you need **all** of:

1. A real domain with DNS pointing at the VM (`GF_DOMAIN`, `GF_ACME_EMAIL`,
   `ALLOWED_ORIGINS` in `.env`), and ports 80/443 opened in `firewalld`.
2. A compensating control in front of the API — pick the strongest you can
   operate: **mutual TLS client certificates** in Caddy, or at minimum an **IP
   allowlist** (`@denied not remote_ip …` + `handle @denied { abort }` in the
   Caddyfile) for your known IPs.
3. Acceptance that without one of these, you are running an unauthenticated
   AI code-execution service on the public internet (see the warning at the
   top of this guide and `docs/THREAT_MODEL.md` §5.2).

---

## Troubleshooting

| Symptom | What to check |
|---|---|
| `docker compose up` fails on the postgres healthcheck | `docker compose logs postgres` — usually a wrong `POSTGRES_PASSWORD` vs an old volume. Nuclear option: `docker compose down -v` (deletes the DB volume — only before you have data!) and re-run. |
| Caddy has no certificate after 2 minutes | `docker compose logs reverse-proxy`. Tailnet names get certs automatically; if it fails, `tailscale status` on the VM first. |
| API log shows `DATABASE_URL is not set` | The `.env` from Step 6 — check the `DATABASE_URL=` line exists and has no spaces. |
| Frontend (Vercel) says "backend unreachable" | `VITE_API_URL` must be `https://YOUR_TAILNET_NAME.ts.net/api` and your laptop needs Tailscale connected. The value is baked at build time — redeploy Vercel after changing it. |
| Builds fail with "Chromium unavailable" | The worker downloads Playwright's browser on first use; check `docker compose logs worker` and that the VM has ~2 GB free disk. |
| Cloudflare calls fail with 401 | The token in `.env` is wrong, lacks the Workers AI permission, or has trailing whitespace. Re-run the token `sed` line from Step 6 with the correct token, then `docker compose restart api worker`. |
