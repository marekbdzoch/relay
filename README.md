<div align="center">

<img src="web/public/favicon.svg" width="72" height="72" alt="Relay logo">

# Relay

**Your team's chat, on your own server.** An open-source alternative to Slack that you can run yourself in a few minutes.
It has the channels, threads, DMs and calls your team already knows, plus AI teammates. All your data stays with you.

**[▶ Try the live demo](https://relay-production-e8b7.up.railway.app)** – no sign-up, resets every 24 hours

[![Deploy on Railway](https://railway.com/button.svg)](docs/deployment.md#railway)
&nbsp;
[![CI](https://github.com/marekbdzoch/relay/actions/workflows/ci.yml/badge.svg)](https://github.com/marekbdzoch/relay/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-6750a4)](LICENSE)

![Relay](docs/screenshots/app.png)

</div>

## Why Relay

- **Familiar from day one.** Your team gets the same layout and everyday features they know from Slack: channels, threads, DMs, reactions, mentions, search, huddles and "Later". Nobody has to relearn anything.
- **Yours.** Relay runs on your server, and your messages and files never leave it. There are no per-seat fees, no message limits and no history paywall.
- **Easy to move to.** You can import your whole Slack workspace: channels, messages, threads, reactions and files, with their original dates. Or keep talking to people who stay on Slack through the built-in [Slack bridge](docs/slack-bridge.md).
- **AI teammates.** You can add AI agents with a name, a role and responsibilities, for example "Mia from Marketing". You can DM them, invite them to channels and give them tasks. They work with Claude, OpenAI, Gemini, Mistral, OpenRouter or a local model.
- **Light.** Relay is one small container with a built-in database. A $5 server runs a team of dozens of people.

## Get started (no technical skills needed)

There are two ways to run Relay. Pick one.

### Option A: Railway (easiest, about 5 minutes)

Railway is a hosting service. It runs Relay for you, with HTTPS and backups of the server disk included. A small team usually costs about $5 per month.

1. Click the **Deploy on Railway** button at the top of this page. Create a free Railway account if you don't have one yet.
2. Click **Deploy**. You don't need to fill anything in, because the defaults work. Wait about 2 minutes until the service shows **Active**.
3. Open the **Deploy Logs** of the service. They contain a line like this:
   `▶ Create your workspace: https://relay-production-1234.up.railway.app/setup?code=k7m2x9pq…`
   Click the link.
   > The *setup code* makes sure that only you can create the workspace on your new server. The code is also stored in the service's **Variables** tab as `SETUP_TOKEN`.
4. Enter your company name, your name, your e-mail and a password. You are now the workspace owner.
5. The **setup guide** opens. It walks you through creating channels, connecting AI and importing from Slack, and then gives you an invite link to send to your team.

**Want your own address, like `chat.yourcompany.com`?** Go to Railway → your service → **Settings → Networking → Custom Domain**, enter the address and add the DNS record Railway shows you at your domain provider. You can also ask whoever manages your domain to do it.

### Option B: Your own server (VPS) with Docker

Any Linux server with 1 GB of RAM is enough, from providers such as Hetzner, DigitalOcean or OVH.

1. Point a domain, for example `chat.yourcompany.com`, at your server's IP address. Your domain provider has an "A record" setting for this.
2. Log in to the server and run:
   ```bash
   curl -fsSL https://get.docker.com | sh
   git clone https://github.com/marekbdzoch/relay.git && cd relay
   cp .env.example .env && nano .env      # set DOMAIN=chat.yourcompany.com, save with Ctrl+O, Enter, Ctrl+X
   docker compose up -d
   docker compose logs relay | grep setup  # shows your setup link with the setup code
   ```
3. Open the link, create your workspace and follow the setup guide. HTTPS certificates are created automatically.

The full guide is in [docs/deployment.md](docs/deployment.md). It covers backups, updates, calls behind strict firewalls, your own reverse proxy and running without Docker.

## The setup guide

After you create the workspace, Relay walks you through these steps. You can skip any of them and come back later from **workspace menu → Setup guide**.

| Step | What happens |
|---|---|
| **Channels and sections** | Pick a starting point (*small team*, *company with departments*, *agency* or *from scratch*) and adjust it. Rename channels, choose which are private, decide which ones everyone joins automatically, and group them into sections that appear in everyone's sidebar. |
| **AI teammates** | Choose an AI provider and paste its API key. Relay tests the key and lists the available models. You pay the provider directly, and only for what your agents use. |
| **Import from Slack** | Upload your Slack export (a `.zip` file). Channels, messages, threads, reactions, pins and files arrive with their original dates. See [Moving from Slack](#moving-from-slack). |
| **Invite your team** | Create an invite link and send it however you like. Relay doesn't send e-mails itself. |

## Moving from Slack

1. **Export from Slack.** In Slack, open **workspace name → Tools & settings → Workspace settings → Import/Export Data → Export**. Choose a date range and wait for Slack's e-mail with the download link. ([Slack's guide](https://slack.com/help/articles/201658943))
   - On the free and Pro plans, the export contains public channels.
   - Business+ and Enterprise plans can also export private channels and DMs.
2. **Import into Relay.** Use the setup guide, or later **workspace menu → Workspace settings → Import from Slack**. Upload the `.zip`.
   - Importing the same export again doesn't create duplicates, so you can also import a newer export later.
3. **Invite your colleagues** with an invite link. When someone signs up with the **same e-mail address** they used in Slack, they get their imported account back. Their name, avatar and full message history stay connected to them.
4. **Not everyone switching on the same day?** The [Slack bridge](docs/slack-bridge.md) keeps chosen channels in sync both ways. Your team uses Relay, partners keep using Slack, and nobody pays for it.

More details: [docs/slack-import.md](docs/slack-import.md).

## AI teammates

Add an agent from **Direct messages → Add agent**, from the **+** button, or on the **Agents** page. Give the agent a name, a role, a team and a list of responsibilities. It then works like a colleague:

- DM it, @mention it in channels and reply in its threads.
- Give it tasks. It can post to other channels, DM people, hand part of a job to another agent, read and search messages, and search the web (with Claude).
- Build teams per department, for example Marketing, Development and Support, each with its own agents.

**Supported providers:**

- Anthropic Claude (recommended)
- OpenAI
- Google Gemini
- Mistral
- OpenRouter
- Ollama (local models, free)
- Any OpenAI-compatible endpoint

An admin sets the provider in the setup guide or in **Workspace settings → AI agents**. The key stays on your server. See [docs/ai-agents.md](docs/ai-agents.md).

## What's inside

| | |
|---|---|
| **Conversations** | Public and private channels, DMs and group DMs, threads, reactions, @mentions and @here/@channel, rich formatting, link previews, editing, pins, "Later" with reminders, scheduled messages, drafts |
| **Calls** | Huddles in DMs. Every channel has a voice room, Discord-style, that people drop in and out of. Calls support video and screen sharing. |
| **Finding things** | Full-text search with filters (`in:`, `from:`, `has:`, `before:`…), Activity, Unreads, Threads, a files browser, and a ⌘K quick switcher |
| **Your way** | Light and dark mode, 7 colour themes, a configurable top bar, custom sidebar sections, Czech and English, keyboard shortcuts |
| **Admin** | Invite links, roles (owner, admin, member, guest), custom emoji, incoming webhooks, the Slack bridge and Slack import, AI providers, and a CLI for backups and password resets |
| **Everywhere** | Web, plus a mobile layout ready for app wrappers. See [docs/desktop-and-mobile.md](docs/desktop-and-mobile.md) for Electron, Capacitor and the API. |

## Everyday admin

| Task | Railway | Docker |
|---|---|---|
| **Update to a new version** | Redeploy the service. It updates automatically if you deployed from your own fork. | `git pull && docker compose up -d --build` |
| **Back up** | Volume backups in Railway → service → **Backups** | `docker compose exec relay node server/src/cli.ts backup` |
| **Reset someone's password** | With the [Railway CLI](https://docs.railway.com/guides/cli): `railway ssh`, then `node server/src/cli.ts reset-password jana@firma.cz 'NewPassw0rd'` | `docker compose exec relay node server/src/cli.ts reset-password jana@firma.cz 'NewPassw0rd'` |

The database and uploads live in one folder (`/data`). Back up that folder and you have everything. Database migrations run automatically when Relay starts.

## Configuration

Everything works without configuration. These environment variables are optional:

| Variable | What it does |
|---|---|
| `PUBLIC_URL` | Public address of the server. Set automatically on Railway and by Docker Compose from `DOMAIN`. |
| `SETUP_TOKEN` | The code needed to create the workspace. Generated automatically if it's not set. |
| `MAX_UPLOAD_MB` | Maximum size of an uploaded file. The default is 100. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`, `AI_PROVIDER`, `AI_MODEL`, `AI_BASE_URL` | AI provider settings. These can also be set in the app. |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | Tokens for the Slack bridge. These can also be set in the app. |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_PASSWORD` | A TURN server, for calls behind strict company firewalls |

The full list is in [docs/deployment.md](docs/deployment.md#11-configuration-reference).

## For developers

Relay needs Node.js 24 or newer. The server runs TypeScript directly, so there is no build step.

```bash
npm install
npm run dev        # API on :3000, web on :5173 with hot reload
npm test           # server (node:test) and web (vitest) unit tests
npm run test:e2e   # Playwright end-to-end tests
```

- [Architecture](docs/architecture.md)
- [REST and realtime API](docs/api.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)

## License

[AGPL-3.0-or-later](LICENSE). You can use, change and self-host Relay freely. If you offer a modified version to others as a service, you must share your changes.
