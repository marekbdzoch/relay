# API reference

Relay's web client uses the same HTTP and WebSocket API that is available to scripts, bots, desktop and mobile apps. The authoritative types for
every payload and event are in [`shared/types.ts`](../shared/types.ts).

> The API is not yet versioned. Until 1.0 it can change between minor releases. Changes are noted in the [changelog](../CHANGELOG.md).

- [Conventions](#conventions)
- [Authentication](#authentication)
- [Endpoints](#endpoints)
- [Incoming webhooks](#incoming-webhooks)
- [Realtime events (Socket.IO)](#realtime-events-socketio)

## Conventions

- Base URL: your Relay origin, e.g. `https://chat.example.com`. All endpoints are under `/api`.
- Request and response bodies are JSON (`Content-Type: application/json`), except file uploads (`multipart/form-data`) and file downloads.
- Timestamps are milliseconds since the Unix epoch. Message IDs are integers; other IDs are strings (`U…` user, `C…` channel, `D…` DM, `F…` file).
- Message text uses chat markdown with tokens for references: `<@U123>` mentions a user, `<#C123>` links a channel, `<!here>` and `<!channel>` are
  broadcast mentions.
- Errors return a non-2xx status with `{ "error": "<code>", "message": "<details>" }`. Common codes: `not_authenticated` (401), `admin_only` (403),
  `not_found` (404), `bad_request` / validation errors (400), `file_too_large` (413), `internal_error` (500).
- The request body limit is 2 MB for JSON. Uploads are limited by `MAX_UPLOAD_MB` per file.
- Login and sign-up allow 10 requests per minute per IP; incoming webhooks allow 60 requests per minute.

## Authentication

Log in with e-mail (or username) and password:

```bash
curl -s https://chat.example.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"jane@example.com","password":"…"}'
# {"token":"3f9c…","me":{"id":"U…","username":"jane",…}}
```

The response contains a session `token` and also sets the `relay_session` cookie (HttpOnly). Use either:

- the cookie, for browsers on the same origin, or
- `Authorization: Bearer <token>` for everything else (scripts, desktop or mobile apps, cross-origin clients).

```bash
TOKEN=3f9c…
curl -s https://chat.example.com/api/bootstrap -H "Authorization: Bearer $TOKEN"
```

Sessions last until logout, and expire after 90 days without use. `POST /api/auth/logout` ends the current session. There are no separate API keys
yet. For automation, use a dedicated user account or an [incoming webhook](#incoming-webhooks).

Cross-origin browser clients must be listed in `CORS_ORIGINS`.

## Endpoints

Unless noted otherwise, endpoints require authentication. **Admin** means the caller must be a workspace owner or admin.

### Health and setup

| Method | Path                | Auth | Description                                                                   |
| ------ | ------------------- | ---- | ----------------------------------------------------------------------------- |
| GET    | `/api/health`       | none | `{ ok, version }`                                                             |
| GET    | `/api/setup/status` | none | Whether the workspace still needs to be set up, plus its public name and icon |
| POST   | `/api/setup`        | none | Create the workspace and the owner account (only while no users exist)        |

### Authentication and sessions

| Method | Path                      | Auth | Description                                                               |
| ------ | ------------------------- | ---- | ------------------------------------------------------------------------- |
| POST   | `/api/auth/login`         | none | `{ email, password }` → `{ token, me }`. `email` may also be a username.  |
| GET    | `/api/invites/:code`      | none | Validate an invite link; returns workspace name and pre-filled e-mail     |
| POST   | `/api/auth/signup`        | none | `{ inviteCode?, fullName, email, password, timezone? }` → `{ token, me }` |
| POST   | `/api/auth/logout`        | user | End the current session                                                   |
| GET    | `/api/auth/sessions`      | user | List your active sessions                                                 |
| POST   | `/api/auth/logout-others` | user | End all your other sessions                                               |
| PUT    | `/api/auth/password`      | user | Change your password                                                      |

### Bootstrap, users and profile

| Method | Path                     | Auth  | Description                                                                                                                                 |
| ------ | ------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/bootstrap`         | user  | Initial state: `me`, workspace, users, channels, memberships, presence, drafts, custom emoji, huddles, agents, counts (`BootstrapResponse`) |
| GET    | `/api/users`             | user  | All users (e-mail addresses only for admins)                                                                                                |
| GET    | `/api/users/:id`         | user  | One user                                                                                                                                    |
| PATCH  | `/api/users/me`          | user  | Update your profile (name, display name, title, phone, timezone, …)                                                                         |
| PUT    | `/api/users/me/avatar`   | user  | Upload a profile photo (multipart)                                                                                                          |
| DELETE | `/api/users/me/avatar`   | user  | Remove your profile photo                                                                                                                   |
| PUT    | `/api/users/me/status`   | user  | Set custom status (emoji, text, expiry)                                                                                                     |
| PUT    | `/api/users/me/presence` | user  | `{ away: boolean }`                                                                                                                         |
| PUT    | `/api/users/me/dnd`      | user  | Pause notifications until a time                                                                                                            |
| PUT    | `/api/users/me/prefs`    | user  | Update preferences (`UserPrefs`)                                                                                                            |
| PATCH  | `/api/users/:id`         | admin | Change role, deactivate or reactivate, rename                                                                                               |
| GET    | `/api/avatars/:id`       | user  | Profile photo                                                                                                                               |

### Workspace administration

| Method | Path                  | Auth             | Description                                                                                                          |
| ------ | --------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| PATCH  | `/api/workspace`      | admin            | Name, allowed sign-up domains                                                                                        |
| PUT    | `/api/workspace/icon` | admin            | Upload workspace icon (multipart)                                                                                    |
| GET    | `/api/workspace/icon` | none             | Workspace icon                                                                                                       |
| GET    | `/api/invites`        | admin            | List invite links                                                                                                    |
| POST   | `/api/invites`        | user (not guest) | Create an invite link with optional e-mail, maximum uses and expiry; only admins can choose a role other than member |
| DELETE | `/api/invites/:code`  | admin            | Revoke an invite                                                                                                     |
| POST   | `/api/emoji`          | user (not guest) | Upload a custom emoji (multipart)                                                                                    |
| DELETE | `/api/emoji/:name`    | creator or admin | Delete a custom emoji                                                                                                |
| GET    | `/api/emoji/:name`    | user             | Custom emoji image                                                                                                   |
| GET    | `/api/webhooks`       | admin            | List incoming webhooks                                                                                               |
| POST   | `/api/webhooks`       | admin            | `{ name, channelId }` → webhook with its secret `url`                                                                |
| DELETE | `/api/webhooks/:id`   | admin            | Delete a webhook                                                                                                     |

### Channels and DMs

| Method | Path                                | Auth             | Description                                                                                    |
| ------ | ----------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| GET    | `/api/channels`                     | user             | Public channels and private channels you belong to                                             |
| POST   | `/api/channels`                     | user             | Create a channel                                                                               |
| GET    | `/api/channels/:id`                 | user             | One channel                                                                                    |
| PATCH  | `/api/channels/:id`                 | member           | Change topic or description; rename (channel creator or admin); default flag (admin)           |
| POST   | `/api/channels/:id/join`            | user             | Join a public channel                                                                          |
| POST   | `/api/channels/:id/leave`           | member           | Leave                                                                                          |
| POST   | `/api/channels/:id/archive`         | creator or admin | Archive                                                                                        |
| POST   | `/api/channels/:id/unarchive`       | creator or admin | Unarchive                                                                                      |
| DELETE | `/api/channels/:id`                 | admin            | Delete a channel and its messages                                                              |
| GET    | `/api/channels/:id/members`         | reader           | Member IDs                                                                                     |
| POST   | `/api/channels/:id/members`         | member           | Add members                                                                                    |
| DELETE | `/api/channels/:id/members/:userId` | member           | Remove a member                                                                                |
| PUT    | `/api/channels/:id/read`            | member           | Mark read up to a message ID                                                                   |
| PUT    | `/api/channels/:id/prefs`           | member           | `{ starred?, muted?, notify?, hidden? }`                                                       |
| GET    | `/api/channels/:id/pins`            | reader           | Pinned messages                                                                                |
| GET    | `/api/channels/:id/files`           | reader           | Files shared in the channel                                                                    |
| GET    | `/api/channels/:id/links`           | reader           | Links shared in the channel                                                                    |
| POST   | `/api/dms`                          | user             | `{ userIds }` → open (or create) a 1:1 or group DM. An empty list opens your notes-to-self DM. |
| GET    | `/api/dms/latest`                   | user             | Latest message of each of your DMs (for previews)                                              |

Exact permission rules (for example, who may rename or archive a channel, and what guests may do) are enforced in `server/src/routes/channels.ts`.

### Messages, threads and reactions

| Method | Path                                 | Auth            | Description                                                                                         |
| ------ | ------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------- |
| GET    | `/api/channels/:id/messages`         | reader          | Page of messages: `?before=<id>`, `?after=<id>` or `?around=<id>`, `&limit=1..200` → `MessagesPage` |
| GET    | `/api/channels/:id/message-at`       | reader          | `?ts=<ms>` → ID of the first message at or after a time                                             |
| POST   | `/api/channels/:id/messages`         | member          | `{ text, threadRootId?, alsoInChannel?, fileIds?, clientId? }` → `Message`                          |
| GET    | `/api/messages/:id`                  | reader          | One message                                                                                         |
| PATCH  | `/api/messages/:id`                  | author          | Edit text                                                                                           |
| DELETE | `/api/messages/:id`                  | author or admin | Delete                                                                                              |
| GET    | `/api/messages/:id/thread`           | reader          | Thread root and replies                                                                             |
| PUT    | `/api/messages/:id/thread/read`      | reader          | Mark thread read                                                                                    |
| PUT    | `/api/messages/:id/thread/follow`    | reader          | Follow or unfollow a thread                                                                         |
| POST   | `/api/messages/:id/reactions`        | member          | `{ emoji }`                                                                                         |
| DELETE | `/api/messages/:id/reactions/:emoji` | member          | Remove your reaction                                                                                |
| POST   | `/api/messages/:id/pin`              | member          | Pin                                                                                                 |
| DELETE | `/api/messages/:id/pin`              | member          | Unpin                                                                                               |
| POST   | `/api/messages/:id/unread`           | member          | Mark unread from this message                                                                       |
| POST   | `/api/messages/:id/save`             | reader          | Save for later; `{ remindAt? }` sets a reminder                                                     |
| PUT    | `/api/messages/:id/save`             | reader          | `{ state?: 'progress' \| 'completed' \| 'archived', remindAt? }`                                    |
| DELETE | `/api/messages/:id/save`             | reader          | Remove from Later                                                                                   |

### Files

| Method | Path                   | Auth              | Description                                                                                                             |
| ------ | ---------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/files`           | user              | Upload up to 10 files (multipart) → `FileInfo[]`. Attach them by passing their IDs as `fileIds` when posting a message. |
| GET    | `/api/files/:id/:name` | reader            | Download; `?download=1` forces an attachment                                                                            |
| DELETE | `/api/files/:id`       | uploader or admin | Delete a file                                                                                                           |
| GET    | `/api/files`           | user              | File browser: `?mine`, `?shared`, `?type=images\|pdfs\|documents\|spreadsheets\|media\|archives\|other`, `?q=`          |

Example: upload a file and post it.

```bash
FILE_ID=$(curl -s https://chat.example.com/api/files -H "Authorization: Bearer $TOKEN" \
  -F file=@report.pdf | jq -r '.[0].id')
curl -s https://chat.example.com/api/channels/C123/messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"text\":\"Monthly report\",\"fileIds\":[\"$FILE_ID\"]}"
```

### Search, activity and personal views

| Method | Path                 | Auth | Description                                                                                                                                                                                                                                                   |
| ------ | -------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/search`        | user | `?q=…&type=all\|messages\|files\|channels\|people&sort=relevance\|newest\|oldest&limit&offset` → `SearchResults`. `q` supports `in:#channel`, `in:@user`, `from:@user`, `before:YYYY-MM-DD`, `after:`, `on:`, `is:thread`, `has:file`, `has:link`, `has:pin`. |
| GET    | `/api/counts`        | user | Unread counts for Activity and Threads                                                                                                                                                                                                                        |
| GET    | `/api/activity`      | user | `?filter=all\|dms\|mentions\|reactions\|threads\|reminders\|unread&before=<ms>`                                                                                                                                                                               |
| PUT    | `/api/activity/read` | user | Mark activity items read                                                                                                                                                                                                                                      |
| GET    | `/api/threads`       | user | Followed threads with unread state (`ThreadSummary[]`)                                                                                                                                                                                                        |
| GET    | `/api/unreads`       | user | Unread messages grouped by conversation (`UnreadGroup[]`)                                                                                                                                                                                                     |
| GET    | `/api/saved`         | user | Saved items (Later)                                                                                                                                                                                                                                           |
| GET    | `/api/saved/count`   | user | Number of open saved items                                                                                                                                                                                                                                    |
| PUT    | `/api/drafts`        | user | `{ channelId, threadRootId?, text }`. Empty text deletes the draft.                                                                                                                                                                                           |
| GET    | `/api/scheduled`     | user | Your scheduled messages                                                                                                                                                                                                                                       |
| POST   | `/api/scheduled`     | user | Schedule a message                                                                                                                                                                                                                                            |
| PATCH  | `/api/scheduled/:id` | user | Edit text or time                                                                                                                                                                                                                                             |
| DELETE | `/api/scheduled/:id` | user | Cancel                                                                                                                                                                                                                                                        |
| GET    | `/api/sent`          | user | Messages you sent recently                                                                                                                                                                                                                                    |
| GET    | `/api/huddles`       | user | Huddle history (`HuddleSession[]`)                                                                                                                                                                                                                            |

### AI agents

| Method | Path                        | Auth             | Description                                                                                                                                                                                                                         |
| ------ | --------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/agents`               | user             | All agents (`AgentInfo[]`)                                                                                                                                                                                                          |
| GET    | `/api/agents/:id`           | user             | One agent                                                                                                                                                                                                                           |
| POST   | `/api/agents`               | user (not guest) | `{ name, role, department?, instructions, model?, webSearch?, avatarEmoji?, avatarColor?, replyMode?, channelIds? }`                                                                                                                |
| PATCH  | `/api/agents/:id`           | creator or admin | Update an agent                                                                                                                                                                                                                     |
| DELETE | `/api/agents/:id`           | creator or admin | Deactivate an agent                                                                                                                                                                                                                 |
| POST   | `/api/agents/:id/restore`   | creator or admin | Reactivate an agent                                                                                                                                                                                                                 |
| GET    | `/api/agents/settings`      | user             | `AgentSettings`: `{ configured, fromEnv, models, provider, providers, baseUrl, defaultModel, providerFromEnv }`. Keys are never returned (`providers[].keySet` only); `baseUrl` is empty for non-admins                             |
| PUT    | `/api/agents/settings`      | admin            | `{ provider?, apiKey?: string \| null, baseUrl?, defaultModel? }` → `AgentSettings`. Saves the provider and its key, fetches and caches the model list and picks a default model. `{ apiKey }` alone applies to the active provider |
| POST   | `/api/agents/settings/test` | admin            | `{ provider, apiKey?, baseUrl? }` → `{ ok: true, models: [{ id, name }] }` or `{ ok: false, error }`. Checks a key / endpoint without saving; uses the stored key when `apiKey` is omitted                                          |

### Slack bridge (admin)

| Method | Path                           | Auth       | Description                                                        |
| ------ | ------------------------------ | ---------- | ------------------------------------------------------------------ |
| GET    | `/api/slack`                   | admin      | Status, which tokens are set, linked channels and the app manifest |
| PUT    | `/api/slack/tokens`            | admin      | `{ botToken: "xoxb-…", appToken: "xapp-…" }` and connect           |
| DELETE | `/api/slack/tokens`            | admin      | Remove tokens and disconnect                                       |
| GET    | `/api/slack/channels`          | admin      | Slack channels visible to the app                                  |
| POST   | `/api/slack/links`             | admin      | `{ relayChannelId, slackChannelId, importHistory?: 0..500 }`       |
| DELETE | `/api/slack/links/:id`         | admin      | Unlink a Relay channel                                             |
| GET    | `/api/public/avatars/:id/:sig` | signed URL | Avatar for Slack, protected by an HMAC signature                   |

## Incoming webhooks

Incoming webhooks let external systems (CI, monitoring, cron jobs) post into a channel without a user account.

1. An admin opens **workspace menu → Integrations & webhooks**, chooses a channel and a name, and copies the URL, which has the form
   `https://chat.example.com/api/hooks/<secret-token>`. The URL is built from `PUBLIC_URL`, so set that variable.
2. Send a `POST` with a JSON body:

| Field      | Type   | Required | Description                                                                     |
| ---------- | ------ | -------- | ------------------------------------------------------------------------------- |
| `text`     | string | yes      | Message text in chat markdown (`*bold*`, `_italic_`, `` `code` ``, links, …)    |
| `username` | string | no       | Display name for this message (defaults to the webhook name, max 80 characters) |

```bash
curl -X POST https://chat.example.com/api/hooks/9b1d4c… \
  -H 'Content-Type: application/json' \
  -d '{"text":"*Deploy finished* :rocket: `main@4f2c1e0` is live on production","username":"CI"}'
# {"ok":true}
```

The message appears in the channel as an app message. The endpoint returns `404` for an unknown token, `400` if the channel is archived, and `429` above
60 requests per minute. Anyone with the URL can post, so keep it secret; delete and recreate the webhook to rotate it.

## Realtime events (Socket.IO)

Connect with [Socket.IO client 4.x](https://socket.io/docs/v4/client-api/) to the server origin (path `/socket.io`). Authenticate with the session
cookie or a token:

```ts
import { io } from 'socket.io-client';
import type { ClientEvents, ServerEvents } from './shared/types';

const socket = io('https://chat.example.com', {
  auth: { token },
  transports: ['websocket', 'polling'],
});
socket.on('connect_error', (err) => {
  if (err.message === 'not_authenticated') {
    /* log in again */
  }
});
socket.on('message:new', (m) => console.log(m.channelId, m.text));
```

After connecting, the socket automatically receives events for the user and for every channel the user is a member of. Load the initial state with
`GET /api/bootstrap`, then apply events. After a reconnect, refetch what you display, because events sent while disconnected are not replayed.

### Server → client

| Event               | Payload                                    | When                                                                                        |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `message:new`       | `Message`                                  | A message was posted (including thread replies)                                             |
| `message:updated`   | `Message`                                  | Edited, reacted to, pinned, link preview added, thread counters changed                     |
| `message:deleted`   | `{ id, channelId, threadRootId }`          | A message was deleted                                                                       |
| `channel:upsert`    | `Channel`                                  | A channel was created or changed, or you gained access                                      |
| `channel:removed`   | `{ channelId }`                            | You lost access to a channel                                                                |
| `membership:upsert` | `Membership`                               | Your per-channel state changed (read marker, unread and mention counts, star, mute, …)      |
| `user:upsert`       | `User`                                     | A user was created or changed (profile, status, role, deactivation)                         |
| `me:updated`        | `Me`                                       | Your own account or preferences changed (from any device)                                   |
| `presence`          | `{ userId, presence: 'active' \| 'away' }` | Presence changed                                                                            |
| `typing`            | `{ channelId, threadRootId, userId }`      | Someone is typing (sent repeatedly; expire it after a few seconds)                          |
| `saved:changed`     | `{ messageId, saved }`                     | A message was saved or unsaved                                                              |
| `draft:changed`     | `Draft & { deleted? }`                     | A draft changed on another device                                                           |
| `activity:new`      | `ActivityItem`                             | New mention, reaction, reply, invite or reminder                                            |
| `thread:read`       | `{ rootId, lastRead }`                     | You read a thread on another device                                                         |
| `emoji:changed`     | `CustomEmoji[]`                            | Custom emoji list changed                                                                   |
| `workspace:updated` | `Workspace`                                | Workspace name, icon or settings changed                                                    |
| `huddle:state`      | `HuddleState`                              | A huddle started or its participants or media changed                                       |
| `huddle:ended`      | `{ channelId }`                            | The last participant left a huddle                                                          |
| `huddle:signal`     | `{ from, channelId, data }`                | WebRTC signalling from another participant (SDP or ICE candidate)                           |
| `agent:upsert`      | `AgentInfo`                                | An AI agent was created or changed                                                          |
| `agent:removed`     | `{ userId }`                               | An AI agent was removed                                                                     |
| `session:revoked`   | none                                       | This session was logged out or the account was deactivated; the socket is then disconnected |

### Client → server

| Event             | Payload                                 | Description                                                          |
| ----------------- | --------------------------------------- | -------------------------------------------------------------------- |
| `typing`          | `{ channelId, threadRootId }`           | Broadcast a typing indicator (only for channels you are a member of) |
| `presence:active` | none                                    | Re-announce presence (e.g. after returning from idle)                |
| `huddle:join`     | `{ channelId }`, ack `({ ok, error? })` | Join or start the huddle in a channel you are a member of            |
| `huddle:leave`    | `{ channelId }`                         | Leave the huddle                                                     |
| `huddle:media`    | `{ channelId, muted, sharing, video? }` | Update your mute, screen-share and camera flags                      |
| `huddle:signal`   | `{ to, channelId, data }`               | Send WebRTC signalling to another participant of the same huddle     |

See [architecture.md](architecture.md#huddles-calls) for how huddle signalling works.
