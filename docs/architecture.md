# Architecture

This document explains how Relay is put together. It is aimed at contributors and at operators who want to understand what runs on their
server. For the HTTP and socket interface, see [api.md](api.md).

## Overview

```
                      +---------------------------------------------------------------+
 Browser / Electron / |  Relay server (single Node.js 24 process)                      |
 mobile shell         |                                                                |
   |  HTTPS (REST)    |  Fastify ── routes/*  ──┐                                       |
   |----------------->|                         ├── services.ts ── db.ts ── SQLite      |
   |  WebSocket       |  Socket.IO (realtime.ts)┘        │          (relay.db, FTS5)   |
   |<================>|      ▲                           │ event bus                    |
   |                  |      │                 ┌─────────┴──────────┐                  |
   |                  |      │                 ▼                    ▼                  |
   |                  |  jobs.ts         slack/bridge.ts      agents/runtime.ts        |
   |                  |  (timers)        Socket Mode WS ──►   Claude API ──►           |
   |                  +----------------------│-------------------│----------------------+
   |                                         ▼                   ▼
   |   WebRTC media (peer-to-peer,       Slack APIs        Anthropic API
   |   STUN / optional TURN)
   +<=============================> other participants
```

Relay is a monolith on purpose. One container holds the API, the realtime server, background jobs and the built web client. The only stateful
dependency is a SQLite file, so a small VPS can run it and backups are simple.

| Component       | Technology                                                                                                                | Location                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| HTTP API        | [Fastify 5](https://fastify.dev/) with cookie, CORS, multipart, rate-limit, compress and static plugins                   | `server/src/app.ts`, `server/src/routes/`       |
| Realtime        | [Socket.IO 4](https://socket.io/)                                                                                         | `server/src/realtime.ts`                        |
| Database        | SQLite through the built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) module (WAL mode, FTS5)                   | `server/src/db.ts`                              |
| Domain logic    | posting, mentions, threads, membership, activity, the internal event bus                                                  | `server/src/services.ts`, `server/src/model.ts` |
| Background jobs | `setInterval` timers                                                                                                      | `server/src/jobs.ts`                            |
| Link previews   | server-side fetch with private-address blocking                                                                           | `server/src/unfurl.ts`                          |
| Slack bridge    | Slack Web API + Socket Mode WebSocket                                                                                     | `server/src/slack/`                             |
| AI agents       | [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript); fetch for OpenAI-compatible providers | `server/src/agents/`                            |
| Web client      | React 19, Zustand, React Router, Vite                                                                                     | `web/src/`                                      |
| Shared contract | TypeScript types only                                                                                                     | `shared/types.ts`                               |

The server runs TypeScript directly with Node's type stripping, so there is no server build. Only the web client is built (`vite build` into
`web/dist`), and the server serves it as a single-page app with long-lived caching for hashed assets.

## Request lifecycle

1. A request reaches Fastify. Most route groups register a `preHandler` hook (`requireAuth`) that resolves the session token to a user; admin
   endpoints additionally call `requireAdmin`.
2. The route validates input with `zod` (`parse()` helper) and checks access, for example `assertCanRead` or `assertMember` for a channel.
3. Writes go through `services.ts` (for example `postMessage`), which updates the database in a transaction, then:
   - emits Socket.IO events to the affected rooms (`channel:<id>`, `user:<id>`), and
   - emits an event on the in-process **event bus** (`posted`, `edited`, `deleted`, `reaction`). The Slack bridge and the agent runtime subscribe to it.
4. Errors are mapped to `{ "error": "<code>", "message": "..." }` with a matching HTTP status. Clients translate the error codes.

## Data model

The schema is defined by append-only migrations in `server/src/db.ts`. The current version is stored in `schema_version`, and pending migrations run
in a transaction on startup. IDs are short random strings with a type prefix (`U…` users, `C…` channels, `D…` DMs, `F…` files, `W…` webhooks, `S…` scheduled messages), except
messages, which use an autoincrement integer so that ordering and "read up to" markers are cheap. Timestamps are milliseconds since the epoch.

| Migration                     | Tables                                                                                                                                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1: initial schema             | `workspace` (single row), `users`, `sessions`, `channels`, `channel_members`, `messages`, `messages_fts`, `reactions`, `files`, `files_fts`, `pins`, `saved`, `thread_follows`, `activity`, `drafts`, `scheduled`, `invites`, `custom_emoji`, `webhooks` |
| 2: Slack bridge               | `users.external`, `settings` (key/value), `slack_links`, `slack_users`, `slack_messages`                                                                                                                                                                 |
| 3: reminders, huddles, agents | `saved.remind_at`, `saved.reminded`, `huddle_sessions`, `agents`                                                                                                                                                                                         |
| 4: agent options              | `agents.web_search`, `agents.avatar_emoji`, `agents.reply_mode`                                                                                                                                                                                          |

Key concepts:

- **Users.** `role` is `owner`, `admin`, `member` or `guest`. Bots (`is_bot = 1`) include AI agents. People mirrored from Slack have
  `external = 'slack'` and cannot log in. `prefs` is a JSON document (theme, language, sidebar sections, notification settings, …).
- **Channels.** `kind` is `public`, `private`, `dm` (1:1, unique `dm_key` of sorted member IDs) or `group` (group DM). `channel_members` stores
  per-user state: `last_read` (message ID), `starred`, `muted`, `notify`, `hidden`.
- **Messages.** A thread is a root message plus replies whose `thread_root_id` points to it. The root caches `reply_count`, `last_reply_at` and
  `reply_users`. `also_in_channel` marks replies also shown in the channel. `subtype` marks system messages (`join`, `topic`, `huddle`, `bridge`, …)
  and webhook posts (`bot`). `meta` is JSON for extras (bot name, client ID, link previews, origin such as `slack` or `agent`, agent depth). Deletion
  is soft (`deleted_at`).
- **Message text** is stored with stable tokens: `<@U123>` for user mentions, `<#C123>` for channel links and `<!here>` / `<!channel>` for broadcasts,
  so renames do not break old messages.
- **Unreads.** A channel is unread when it has messages with an ID greater than `channel_members.last_read`. Threads use `thread_follows.last_read`.
- **Activity** rows are created for mentions, reactions to your messages, replies in followed threads, channel invites, reminders and DMs.
- **Settings** is a key/value table used for integration secrets (`ai.provider`, `anthropic.apiKey` / `ai.<provider>.apiKey`, `ai.baseUrl`, `ai.defaultModel`, `ai.models`, `slack.botToken`, `slack.appToken`).

## Authentication

- Passwords are hashed with bcrypt (cost 11). Login and sign-up are rate limited (10 requests per minute per IP).
- A successful login, sign-up or initial setup creates a **session**: a random token returned to the client. Only its SHA-256 hash is stored in
  `sessions`. Sessions expire after 90 days of inactivity.
- The token is accepted in two ways:
  - **Cookie** `relay_session` (HttpOnly, `SameSite=Lax`, `Secure` when `PUBLIC_URL` is HTTPS). The web client served from the same origin uses this.
  - **Bearer header** `Authorization: Bearer <token>`. Desktop shells, mobile apps, scripts and web clients on another origin use this.
- Socket.IO connections authenticate with `auth: { token }` in the handshake or with the same cookie.
- Logging out deletes the session and disconnects its sockets (`session:revoked`). Users can sign out other sessions; deactivating a user disconnects
  all their sockets.
- Sign-up requires an invite code unless the user's e-mail domain is in the workspace's allowed domains. The very first account is created through
  `/api/setup` and becomes the owner.
- Incoming webhooks authenticate with the secret token in their URL.

## File storage

Uploads are streamed to disk under `DATA_DIR/uploads`:

| Directory            | Contents            |
| -------------------- | ------------------- |
| `uploads/YYYY-MM/`   | message attachments |
| `uploads/avatars/`   | profile photos      |
| `uploads/emoji/`     | custom emoji        |
| `uploads/workspace/` | workspace icon      |

Files get random names; the original name, MIME type, size and image dimensions are stored in the `files` table. An upload (`POST /api/files`) is
first unattached and is linked to a message when the message is posted with its `fileIds`. Downloads (`GET /api/files/:id/:name`) check that the user
can read the channel. Only a safe list of MIME types (images, audio, video, PDF, plain text) is served inline; everything else is sent as an
attachment, with `X-Content-Type-Options: nosniff`. `MAX_UPLOAD_MB` limits each file.

## Search

Search uses SQLite [FTS5](https://www.sqlite.org/fts5.html) external-content tables:

- `messages_fts` indexes message text and `files_fts` indexes file names. Triggers keep them in sync on insert, update and delete.
- The `unicode61 remove_diacritics 2` tokenizer makes search case- and diacritics-insensitive (`cesky` matches `česky`).
- `GET /api/search` parses modifiers (`in:`, `from:`, `before:`, `after:`, `on:`, `is:thread`, `has:file|link|pin`), turns the remaining words into
  prefix queries, restricts results to channels the user can read, and ranks with `bm25`. It also returns matching people, channels and files.

## Realtime

`server/src/realtime.ts` sets up Socket.IO at `/socket.io`. On connection a socket joins:

- `user:<userId>`, for events addressed to one person on all their devices;
- `session:<hash>`, so a single session can be revoked;
- `channel:<channelId>` for every channel the user is a member of. Joining or leaving a channel updates the rooms of all the user's sockets.

Presence is derived from the number of open sockets per user plus the manual "away" flag. The full list of events is typed in `shared/types.ts`
(`ServerEvents` and `ClientEvents`) and documented in [api.md](api.md#realtime-events-socketio). Most state changes are pushed as upserts of
complete objects (`message:updated`, `channel:upsert`, `membership:upsert`, …), so clients can replace their local copy without merging.

## Background jobs

`server/src/jobs.ts` runs timers inside the server process:

| Interval | Job                                                                                   |
| -------- | ------------------------------------------------------------------------------------- |
| 10 s     | send due scheduled messages                                                           |
| 15 s     | fire due "remind me" reminders (as activity items)                                    |
| 30 s     | clear expired custom statuses and do-not-disturb                                      |
| 6 h      | delete read activity and idle sessions older than 90 days; close stale huddle records |

It also records huddle history and sets the automatic "In a huddle" status.

## Huddles (calls)

Huddles use a **WebRTC mesh**: every participant has a direct `RTCPeerConnection` to every other participant. Media never passes through the Relay
server. This works well for small groups (roughly up to 6-8 people with video). Larger calls would need an SFU, which is not part of Relay.

Signalling goes over Socket.IO:

1. A client sends `huddle:join` for a channel it is a member of. The server keeps the in-memory huddle state (participants, muted, sharing, video)
   and broadcasts `huddle:state` to the channel.
2. Clients exchange SDP offers and answers and ICE candidates with `huddle:signal`. The server only relays these messages, and only between
   participants of the same huddle.
3. The client (`web/src/lib/huddle.ts`) uses the "perfect negotiation" pattern, so either side can renegotiate, for example when someone turns on the
   camera or starts screen sharing.
4. `huddle:media` updates mute, screen-share and video flags. When the last participant leaves, the server emits `huddle:ended` and closes the
   `huddle_sessions` row.

ICE servers come from `STUN_URLS` and `TURN_URLS` and are delivered to clients as part of the workspace object. See
[deployment.md](deployment.md#7-turn-for-calls-behind-strict-firewalls) for TURN.

## Slack bridge

`server/src/slack/` mirrors linked channels with a Slack workspace. See [slack-bridge.md](slack-bridge.md) for setup.

- **Transport:** the server opens an outbound [Socket Mode](https://api.slack.com/apis/socket-mode) WebSocket with the app-level token (`xapp-…`) and
  calls the Web API with the bot token (`xoxb-…`). No public inbound URL is needed. The connection reconnects with exponential backoff (up to 60 s).
- **Inbound:** Slack events (`message.*`, `reaction_*`, `user_change`, renames) are translated to Relay operations. Slack users become external Relay
  users, or are matched to an existing account by e-mail. `slack_messages` maps Slack `ts` values to Relay message IDs for threads, edits and deletes.
- **Outbound:** the bridge listens on the event bus and posts Relay messages with `chat:write.customize`, so they appear with the author's name and
  avatar. Avatars are served from a public URL signed with an HMAC of the server secret (`/api/public/avatars/:id/:sig`).
- **Loop prevention:** messages that came from Slack carry `source = 'slack'` and are not sent back. A per-channel queue keeps ordering and spreads
  requests to stay within Slack rate limits.

## AI agents

`server/src/agents/` implements AI teammates backed by Claude. See [ai-agents.md](ai-agents.md) for setup and privacy.

- **Identity:** an agent is a bot user (`is_bot = 1`, `external = 'agent'`) with a row in `agents` (role, department, instructions, model, web search,
  reply mode). It can be DMed, invited to channels and mentioned like a person.
- **Triggering:** the runtime subscribes to the `posted` event. For each agent that is a member of the channel it decides whether to respond: always in
  a 1:1 DM; when mentioned; in threads it takes part in (unless someone else is addressed); and, with reply mode `all`, to every top-level message.
  Messages from other agents trigger a response only when they mention the agent explicitly.
- **Concurrency:** one run at a time per agent and conversation (channel + thread). Messages arriving during a run are coalesced, and the agent
  answers the latest one afterwards.
- **Tool loop:** the runtime builds a prompt from a stable system prompt (role and instructions, prompt-cached), the workspace directory, the last 40
  messages of the conversation or thread, and up to 4 attached images. It then calls the Messages API in a loop of up to 8 rounds, executing tool
  calls (`send_message`, `read_channel`, `search_messages`, `list_channels`, `add_reaction`, and the server-side `web_search` tool when enabled).
  The final text is posted as the agent's reply in the same conversation or thread.
- **Delegation and depth limit:** `send_message` lets an agent post to another channel or DM a person or another agent. Every message posted by an
  agent records `agentDepth = depth + 1` in its metadata. Messages with depth 4 or more never trigger agents, which stops agent-to-agent loops.
- **Permissions:** agents can only read and post in channels they are members of, and they cannot use `@here`, `@channel` or `@everyone`.

## Web client

- `web/src/api.ts` is a small fetch wrapper. It uses relative URLs with cookies by default, or a configured server URL with a bearer token (see
  [desktop-and-mobile.md](desktop-and-mobile.md)).
- `web/src/socket.ts` connects to Socket.IO and applies events to the Zustand store (`store.ts`). `GET /api/bootstrap` loads the initial state
  (current user, workspace, users, channels, memberships, presence, drafts, custom emoji, active huddles, agents) in one request. Messages are loaded per
  channel with cursor pagination.
- Sends are optimistic: the client renders a pending message with a `clientId` and reconciles it with the server's `message:new` event.
- Heavier views and dialogs are lazy-loaded (`web/src/lib/lazy.ts`) to keep the initial bundle small.
- Below 768 px the layout switches to a mobile UI with bottom tabs.
- i18n is gettext-style with English source strings as keys (`web/src/i18n.ts`).
