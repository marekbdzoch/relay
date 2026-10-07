# Security Policy

Relay is self-hosted software that stores private conversations and files. We take security reports seriously and appreciate responsible
disclosure.

## Supported versions

Relay is in early development (0.x). Security fixes are made on the `main` branch and shipped in the latest release only.

| Version            | Supported          |
| ------------------ | ------------------ |
| latest 0.x release | Yes                |
| older releases     | No, please upgrade |

## Reporting a vulnerability

**Do not open a public issue, pull request or Discussion for security problems.**

Report privately through **GitHub private vulnerability reporting**: go to the repository's **Security** tab and choose
**Report a vulnerability** (<https://github.com/marekbdzoch/relay/security/advisories/new>).

Please include:

- the affected version or commit, and how Relay is deployed;
- a description of the issue and its impact;
- steps to reproduce or a proof of concept;
- any suggested fix.

What to expect:

- We acknowledge your report within **3 working days**.
- We give you an initial assessment within **10 working days**.
- We keep you informed while we work on a fix and agree on a disclosure date with you. We aim to release fixes for critical issues within 30 days.
- With your permission, we credit you in the advisory and the changelog.

Please give us a reasonable amount of time to fix the issue before you disclose it. Only test against your own installation. Do not access other
people's data, and do not degrade the service of instances you do not run.

## Scope

In scope:

- the Relay server (`server/`), web client (`web/`) and shared code in this repository;
- the official Docker image, `Dockerfile` and `docker-compose.yml`, and the bundled Caddy configuration in `deploy/`;
- authentication, sessions and access control (channels, DMs, roles, guests, files);
- the Slack bridge, incoming webhooks and AI agent integration as implemented here (for example, an agent revealing data from channels it is not a
  member of).

Out of scope:

- vulnerabilities in third-party services (Slack, Anthropic, STUN/TURN providers) or upstream dependencies, unless Relay uses them insecurely
  (please report those upstream);
- findings that require a compromised server, a malicious administrator, or physical access to a user's device;
- missing hardening on an instance that ignores the recommendations below (for example, running without HTTPS);
- denial of service from very high traffic volumes, social engineering, and spam;
- reports from automated scanners without a demonstrated impact.

## Hardening checklist for self-hosters

- **Use HTTPS.** The bundled `docker-compose.yml` puts [Caddy](https://caddyserver.com/) in front of Relay and obtains certificates automatically.
  If you use your own reverse proxy, terminate TLS there and set `PUBLIC_URL=https://...`, which also marks session cookies as `Secure`. Do not expose
  port 3000 directly to the internet. See [docs/deployment.md](docs/deployment.md).
- **Protect the secret key.** Relay generates a random key on first start and stores it in `DATA_DIR/.secret` (mode `600`), or uses `SECRET_KEY` if
  set. It signs public avatar URLs used by the Slack bridge. Keep it private, and keep it stable across restarts.
- **Protect the data volume and backups.** `relay.db` contains messages, password hashes (bcrypt), session token hashes, and **integration secrets
  stored in the `settings` table**: the Anthropic API key and Slack tokens, when they are entered in the admin UI. These are stored in plain text in the
  database. If you prefer, set `ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` as environment variables instead. Encrypt backups and restrict
  who can read them.
- **Back up regularly** and test restores. Use `node server/src/cli.ts backup` for a consistent database snapshot and copy `uploads/` as well.
- **Keep the stack up to date.** Rebuild or pull the image regularly to receive Relay, Node.js and Alpine security fixes, and keep Docker, the host OS
  and Caddy updated. Enable automatic security updates on the host where possible.
- **TURN credentials.** If you enable the bundled coturn server, use a long random `TURN_PASSWORD`. These credentials are delivered to every signed-in
  client so it can connect to calls, so treat them as shared, not secret, and do not reuse them elsewhere. Open only the ports listed in the deployment
  guide.
- **Upload limits.** `MAX_UPLOAD_MB` (default 100) limits each uploaded file; Caddy additionally limits request bodies to 200 MB. Lower both if you have
  little disk space. Monitor free disk space on the data volume.
- **Sign-up policy.** By default people can join only with an invite link. Only allow sign-up by e-mail domain if you control that domain. Use personal,
  single-use or expiring invites for guests, and deactivate accounts of people who leave.
- **Webhooks.** Anyone who knows an incoming webhook URL can post to its channel. Treat webhook URLs as secrets and delete unused ones.
- **Link previews.** Relay fetches URLs posted in messages to build previews and refuses private and loopback addresses. Set `UNFURL_LINKS=false` if
  your server must not make outbound requests.
- **AI agents.** Messages from conversations an agent takes part in are sent to Anthropic. See [docs/ai-agents.md](docs/ai-agents.md) and make sure
  this is acceptable for your organisation before you enable agents.
- **Firewall.** Expose only ports 80 and 443 (plus the TURN ports if you use coturn). Restrict SSH access.
