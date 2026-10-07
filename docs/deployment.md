# Deploying Relay on a VPS

This guide takes you from an empty Linux server to a running Relay instance with HTTPS, optional TURN for calls, backups and updates. It assumes a
recent Ubuntu or Debian server, but any Linux host that runs Docker works.

- [1. Requirements and sizing](#1-requirements-and-sizing)
- [2. DNS](#2-dns)
- [3. Install Docker](#3-install-docker)
- [4. Get Relay and configure it](#4-get-relay-and-configure-it)
- [5. Start the stack](#5-start-the-stack)
- [6. HTTPS](#6-https)
- [7. TURN for calls behind strict firewalls](#7-turn-for-calls-behind-strict-firewalls)
- [8. Backups and restore](#8-backups-and-restore)
- [9. Updating](#9-updating)
- [10. Using your own reverse proxy instead of Caddy](#10-using-your-own-reverse-proxy-instead-of-caddy)
- [11. Configuration reference](#11-configuration-reference)
- [12. Admin CLI](#12-admin-cli)
- [13. Troubleshooting](#13-troubleshooting)

## 1. Requirements and sizing

Relay runs as one Node.js process with an embedded SQLite database, so it is light. Huddles (calls) are peer-to-peer and do not pass through the
server, unless the TURN relay is used.

| Team size        | vCPU | RAM  | Disk               | Notes                                                                                            |
| ---------------- | ---- | ---- | ------------------ | ------------------------------------------------------------------------------------------------ |
| up to ~25 people | 1    | 1 GB | 10 GB + uploads    | The smallest VPS of most providers is enough.                                                    |
| 25-200 people    | 2    | 2 GB | 20 GB + uploads    | Add swap; consider a separate volume for `/data`.                                                |
| 200+ people      | 2-4  | 4 GB | depends on uploads | SQLite in WAL mode handles this well; uploads and TURN bandwidth usually become the limit first. |

- Plan disk space mainly for uploaded files (`MAX_UPLOAD_MB` per file, default 100 MB) and backups.
- If you run the bundled TURN server, budget bandwidth: a relayed video call can use 1-3 Mbit/s per participant in each direction.
- Building the image on the server needs about 1 GB of free RAM. On a 1 GB VPS, add swap, or use the prebuilt image (see [Updating](#9-updating)).

Ports to open in your firewall:

| Port        | Protocol  | Purpose                                                          |
| ----------- | --------- | ---------------------------------------------------------------- |
| 22          | TCP       | SSH (restrict to your IPs if possible)                           |
| 80          | TCP       | HTTP, used for ACME certificate challenges and redirect to HTTPS |
| 443         | TCP + UDP | HTTPS and HTTP/3                                                 |
| 3478        | TCP + UDP | TURN (only if you enable coturn)                                 |
| 49160-49200 | UDP       | TURN relay ports (only if you enable coturn)                     |

## 2. DNS

Choose a hostname such as `chat.example.com` and create DNS records that point at your server:

```
chat.example.com.   A      203.0.113.10
chat.example.com.   AAAA   2001:db8::10      ; only if the server has IPv6
```

Wait until the record resolves (`dig +short chat.example.com`) before you start the stack, otherwise Caddy cannot obtain a certificate.

## 3. Install Docker

Install Docker Engine and the Compose plugin with Docker's official convenience script, or follow the
[manual instructions for your distribution](https://docs.docker.com/engine/install/):

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"     # log out and back in afterwards
docker compose version              # should print v2.x
```

Optional but recommended on Ubuntu or Debian:

```bash
sudo apt install -y unattended-upgrades ufw
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443 && sudo ufw enable
```

Note that Docker manages its own iptables rules, so published container ports bypass `ufw`. Only publish the ports you need.

## 4. Get Relay and configure it

```bash
git clone https://github.com/marekbdzoch/relay.git relay
cd relay
cp .env.example .env
```

Edit `.env`. The minimum is the domain:

```dotenv
DOMAIN=chat.example.com
```

Other useful settings (all optional):

```dotenv
MAX_UPLOAD_MB=100
UNFURL_LINKS=true
# ANTHROPIC_API_KEY=sk-ant-...          # AI agents, see docs/ai-agents.md
# SLACK_BOT_TOKEN=xoxb-...              # Slack bridge, see docs/slack-bridge.md
# SLACK_APP_TOKEN=xapp-...
# SECRET_KEY=<64 hex chars>             # otherwise generated on first start and stored in /data/.secret
```

`docker-compose.yml` sets `PUBLIC_URL=https://${DOMAIN}` for the Relay container automatically. See the
[configuration reference](#11-configuration-reference) for every variable.

Keep `.env` private (`chmod 600 .env`). It may contain API keys.

## 5. Start the stack

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f relay
```

The stack has three services:

- `relay`: the application (port 3000, reachable only inside the Docker network);
- `caddy`: reverse proxy with automatic HTTPS on ports 80 and 443;
- `coturn`: optional TURN server, started only with the `turn` profile.

On first start Relay prints a setup link that contains a **setup code**:

```bash
docker compose logs relay | grep setup
#   ▶ Create your workspace: https://chat.example.com/setup?code=k7m2x9pq…
```

Open it and create the workspace; the first account becomes the workspace owner. The code makes sure nobody else can claim a freshly started
server. It is stored in `/data/.setup-token`, or you can choose it yourself with the `SETUP_TOKEN` variable. After that, the **setup guide** helps
you create channels and sections, connect an AI provider, import from Slack and invite people. Relay creates invite links that you share yourself;
no mail server is needed.

## Railway

The quickest hosted option is the [Railway template](../README.md#option-a-railway-easiest-about-5-minutes). If you set it up by hand instead:

1. Create a service from this repository (Railway builds the `Dockerfile`; `railway.json` sets the health check).
2. Add a **volume** mounted at `/data` and set the variable `RAILWAY_RUN_UID=0` so the app can write to it.
3. Generate a domain under **Settings → Networking**. `PUBLIC_URL` is derived from it automatically.
4. Open the deploy logs and follow the setup link.

## 6. HTTPS

With the bundled Caddy, HTTPS needs no further setup. Caddy obtains and renews Let's Encrypt certificates for `DOMAIN` and redirects HTTP to HTTPS.
Certificates are stored in the `caddy-data` volume. The configuration is in [`deploy/Caddyfile`](../deploy/Caddyfile):

```caddyfile
{$DOMAIN} {
	encode zstd gzip
	request_body {
		max_size 200MB
	}
	reverse_proxy relay:3000
}
```

If you raise `MAX_UPLOAD_MB` above 200, raise `max_size` as well.

If certificate issuance fails, check that ports 80 and 443 are reachable from the internet and that DNS points at the server:
`docker compose logs caddy`.

## 7. TURN for calls behind strict firewalls

Huddles use WebRTC. Peers connect directly and use public STUN servers to find each other, which works on most home and office networks. People on
some corporate, hotel or mobile networks need a TURN relay. Relay ships an optional [coturn](https://github.com/coturn/coturn) service.

1. Add to `.env` (use a long random password, for example from `openssl rand -hex 24`):

   ```dotenv
   TURN_URLS=turn:chat.example.com:3478
   TURN_USERNAME=relay
   TURN_PASSWORD=<long random string>
   ```

2. Open `3478/tcp`, `3478/udp` and `49160-49200/udp` in the firewall.
3. Start the stack with the profile:

   ```bash
   docker compose --profile turn up -d
   ```

coturn runs with `network_mode: host`, so it binds directly to the host's ports. The ICE server list (STUN plus TURN with credentials) is sent to
signed-in clients in the bootstrap response. You can test the relay with the
[Trickle ICE](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/) page: you should see `relay` candidates.

For larger teams, use a dedicated TURN server or a managed TURN service and list it in `TURN_URLS` (comma-separated). Set `STUN_URLS` to use STUN
servers other than Google's.

## 8. Backups and restore

All state lives in the `relay-data` Docker volume (mounted at `/data`):

| Path                                | Contents                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/data/relay.db` (+ `-wal`, `-shm`) | SQLite database: users, messages, settings (including API keys and Slack tokens entered in the UI) |
| `/data/uploads/`                    | uploaded files, avatars, custom emoji, workspace icon                                              |
| `/data/.secret`                     | generated secret key (unless `SECRET_KEY` is set)                                                  |
| `/data/backups/`                    | default target of the `backup` command                                                             |

Also keep a copy of your `.env` file.

### Create a backup

The `backup` command writes a consistent snapshot of the database (`VACUUM INTO`) while Relay keeps running:

```bash
docker compose exec relay node server/src/cli.ts backup
# Database backed up to /data/backups/relay-2026-10-07T03-00-00-000Z.db
```

Then copy the snapshot, the uploads and the secret off the server. For example, as a nightly cron job on the host:

```bash
#!/bin/sh
# /etc/cron.daily/relay-backup  (chmod +x)
set -eu
cd /opt/relay                                   # where docker-compose.yml lives
DEST=/var/backups/relay/$(date +%F)
mkdir -p "$DEST"
docker compose exec -T relay node server/src/cli.ts backup /data/backups/nightly >/dev/null
docker compose cp relay:/data/backups/nightly "$DEST/db"
docker compose cp relay:/data/uploads "$DEST/uploads"
docker compose cp relay:/data/.secret "$DEST/secret" 2>/dev/null || true
docker compose exec -T relay sh -c 'rm -rf /data/backups/nightly'
find /var/backups/relay -mindepth 1 -maxdepth 1 -mtime +14 -exec rm -rf {} +
```

Push the backup directory to off-site storage (for example with `restic`, `borg` or `rclone`) and encrypt it, because it contains private messages
and integration secrets.

Do not copy `relay.db` with `cp` while the server is running; the WAL file may contain recent writes. Use the `backup` command, or stop the container
first.

### Restore

```bash
docker compose stop relay
# copy the snapshot over the live database and remove stale WAL files
docker compose cp ./backup/db/relay-<timestamp>.db relay:/data/relay.db
docker compose run --rm --no-deps --entrypoint sh relay -c 'rm -f /data/relay.db-wal /data/relay.db-shm'
docker compose cp ./backup/uploads/. relay:/data/uploads/
docker compose cp ./backup/secret relay:/data/.secret
docker compose start relay
```

`docker compose cp` works with stopped containers. If file ownership is wrong afterwards, fix it with
`docker compose run --rm --no-deps --user root --entrypoint chown relay -R node:node /data`.

Migrations run on startup, so you can restore a backup from an older Relay version into a newer one. Restoring a newer database into an older Relay
version is not supported.

## 9. Updating

Read the [changelog](../CHANGELOG.md) first, take a backup, then:

```bash
cd relay
git pull
docker compose up -d --build
docker image prune -f
```

Database migrations run automatically when the new container starts. Check `docker compose logs relay` afterwards.

### Using the prebuilt image

Release images are published to the GitHub Container Registry for `linux/amd64` and `linux/arm64`. To use them instead of building on the
server, override the image in a `docker-compose.override.yml`:

```yaml
services:
  relay:
    image: ghcr.io/marekbdzoch/relay:0.1 # pin a minor version
    build: !reset null
```

Then update with `docker compose pull && docker compose up -d`.

Also keep the host, Docker and the Caddy and coturn images up to date (`docker compose pull caddy coturn`).

## 10. Using your own reverse proxy instead of Caddy

If the server already runs nginx, Traefik or another proxy, run only the `relay` service and publish its port on localhost. Create
`docker-compose.override.yml`:

```yaml
services:
  relay:
    ports:
      - '127.0.0.1:3000:3000'
```

and start only Relay:

```bash
docker compose up -d relay
```

Requirements for any reverse proxy:

- Terminate TLS and set `PUBLIC_URL=https://chat.example.com` in `.env` (cookies are marked `Secure` when `PUBLIC_URL` starts with `https://`;
  override with `SECURE_COOKIES=true|false`).
- Forward `X-Forwarded-For` and `X-Forwarded-Proto` (Relay trusts proxy headers).
- Support **WebSocket upgrades on `/socket.io/`**. Without them the client falls back to long-polling, which works but is slower.
- Allow request bodies at least as large as `MAX_UPLOAD_MB`, and do not buffer large uploads in memory.
- Use generous read timeouts for the WebSocket connection.

### nginx example

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name chat.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name chat.example.com;

    ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    client_max_body_size 200m;          # >= MAX_UPLOAD_MB
    proxy_request_buffering off;        # stream uploads to Relay

    location /socket.io/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_buffering off;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

Obtain the certificate with `certbot --nginx -d chat.example.com` or your usual tooling.

### Without Docker

Relay also runs directly on Node.js 24+:

```bash
npm ci
npm run build                       # builds web/dist
DATA_DIR=/var/lib/relay PUBLIC_URL=https://chat.example.com NODE_ENV=production npm start
```

Run it under systemd (or another supervisor) as an unprivileged user, behind a reverse proxy as described above.

## 11. Configuration reference

| Variable                                      | Default                               | Description                                                                                                                   |
| --------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `DOMAIN`                                      | -                                     | Used by `docker-compose.yml` (Caddy site address, `PUBLIC_URL`, coturn realm). Not read by the server itself.                 |
| `PUBLIC_URL`                                  | empty                                 | Public base URL, e.g. `https://chat.example.com`. Used for links, signed avatar URLs for Slack, and the `Secure` cookie flag. |
| `PORT`                                        | `3000`                                | HTTP port.                                                                                                                    |
| `HOST`                                        | `0.0.0.0`                             | Bind address.                                                                                                                 |
| `DATA_DIR`                                    | `/data` in Docker, `./data` otherwise | Database, uploads and secret.                                                                                                 |
| `SECRET_KEY`                                  | generated                             | Secret for signing. Stored in `DATA_DIR/.secret` when not set.                                                                |
| `SECURE_COOKIES`                              | derived from `PUBLIC_URL`             | Force the `Secure` cookie flag on (`true`) or off (`false`).                                                                  |
| `MAX_UPLOAD_MB`                               | `100`                                 | Maximum size of one uploaded file.                                                                                            |
| `UNFURL_LINKS`                                | `true`                                | Fetch link previews for URLs in messages.                                                                                     |
| `STUN_URLS`                                   | `stun:stun.l.google.com:19302`        | Comma-separated STUN URLs for huddles.                                                                                        |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_PASSWORD` | -                                     | TURN server(s) for huddles.                                                                                                   |
| `CORS_ORIGINS`                                | -                                     | Comma-separated extra origins allowed to call the API (desktop or mobile shells, dev servers).                                |
| `ANTHROPIC_API_KEY`                           | -                                     | API key for AI agents. Overrides the key set in the admin UI.                                                                 |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`          | -                                     | Slack bridge tokens. Override the tokens set in the admin UI.                                                                 |
| `LOG_LEVEL`                                   | `info`                                | Fastify log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`).                                             |
| `WEB_DIST`                                    | `web/dist`                            | Location of the built web client.                                                                                             |

## 12. Admin CLI

```bash
docker compose exec relay node server/src/cli.ts users                                # list accounts
docker compose exec relay node server/src/cli.ts backup [dir]                         # consistent DB snapshot
docker compose exec relay node server/src/cli.ts reset-password jane@example.com 'N3w-password'
docker compose exec relay node server/src/cli.ts make-owner jane@example.com
```

`reset-password` also reactivates the account and signs it out on all devices.

## 13. Troubleshooting

- **Health check:** `curl https://chat.example.com/api/health` returns `{"ok":true,"version":"..."}`.
- **Logs:** `docker compose logs -f relay caddy`.
- **"Can't reach the server" in the browser:** check that WebSocket upgrades reach Relay (see the nginx example) and that no proxy strips cookies.
- **Signed out after every restart:** `PUBLIC_URL` starts with `https://` but the site is served over HTTP, so the browser drops the `Secure` cookie.
  Serve over HTTPS or set `SECURE_COOKIES=false` for local testing.
- **Calls connect but there is no audio or video:** enable TURN (section 7) and check the firewall ports.
- **Uploads fail with "file too large":** raise `MAX_UPLOAD_MB` and the proxy body limit (`max_size` in Caddy, `client_max_body_size` in nginx).
