# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - Unreleased

First public release of Relay, a self-hosted team chat with the Slack layout, AI agents and a Slack bridge.

### Added

#### Conversations

- **Channels:** public and private channels; browse, join and leave; topic and description; member management; default channels for new members;
  archive and unarchive; star, mute and per-channel notification levels; pinned messages; files and links tabs in channel details.
- **Direct messages:** 1:1 DMs, group DMs, and a personal notes DM with yourself; DM list with message previews.
- **Messages:** Markdown formatting (bold, italic, strikethrough, inline code and code blocks, quotes, lists, links), `@mentions`, `@here` /
  `@channel`, `#channel` links, edit (with the Up arrow) and delete, link previews, mark as unread, copy link, forward, and permalinks that jump to a message.
- **Threads:** reply in thread, "also send to channel", follow and unfollow, and a Threads view with unread counts.
- **Reactions:** emoji picker, quick reactions and a "who reacted" tooltip.
- **Custom emoji** uploaded by workspace admins.
- **Files:** drag and drop, paste, upload progress, image lightbox, inline video and audio players, and a file browser.
- **Clips:** record audio and video clips directly in the composer.
- **Drafts and scheduled messages:** drafts sync across devices; schedule messages for later ("tomorrow at 9:00"); a list of sent messages.

#### Staying on top of things

- **Unreads:** a view of all unread messages grouped by conversation, plus unread and mention badges in the sidebar and tab title.
- **Activity:** mentions, reactions, thread replies, channel invites and reminders, with unread state and filters.
- **Later:** save messages for later and mark them complete.
- **Reminders:** "Remind me about this" (20 minutes, 1 hour, 3 hours, tomorrow, next week or a custom time); reminders show in Activity and Later.
- **Search:** diacritics-insensitive full-text search (SQLite FTS5) with `in:#channel`, `in:@user`, `from:@user`, `before:`, `after:`, `on:`,
  `has:file`, `has:link`, `has:pin` and `is:thread` modifiers, plus search for people, channels and files.
- **Notifications:** desktop notifications, sounds, keyword notifications, working hours, and pausing notifications (do not disturb).
- **Presence:** online and away status, custom status with emoji and expiry, typing indicators.

#### Calls

- **Huddles:** audio calls with **video** and **screen sharing** over WebRTC, started from any channel or DM; a huddle window with participant tiles;
  an automatic "In a huddle" status; huddle history and a "happening now" indicator.
- Optional TURN server (coturn) in `docker-compose.yml` for strict NATs and corporate firewalls.

#### Workspace and personalisation

- **Sidebar:** custom sections with emoji (move channels between them), per-section filter (all or unreads) and sort (A-Z or recent), and a
  find-a-conversation filter.
- **Layout:** workspace rail (Home, DMs, Activity, Later, More), top search bar, right panel for threads and profiles, resizable panes.
- **Mobile layout:** below 768 px the client switches to a mobile UI with bottom tabs and list-to-conversation navigation.
- **Themes:** light, dark and system colour modes and 8 sidebar themes.
- **Languages:** English and Czech UI; 12- or 24-hour clock; Enter-to-send preference.
- **Productivity:** Cmd/Ctrl+K quick switcher, keyboard shortcuts, and slash commands (`/me`, `/shrug`, `/topic`, `/invite`, `/leave`, `/status`,
  `/away`, `/dnd`, `/msg`, `/search`).
- **Administration:** invite links (reusable or personal, with optional expiry and role), roles (owner, admin, member, guest), account deactivation,
  workspace name and icon, sign-up by e-mail domain, and session management (sign out other devices).

#### Integrations

- **Incoming webhooks:** post to a channel with a simple `POST /api/hooks/:token` request.
- **Slack bridge:** mirror selected channels with an existing Slack workspace over Socket Mode. Messages, threads, edits, deletions, reactions and
  files sync in both directions; Slack users are matched to Relay accounts by e-mail; optional history import of the last 50-500 messages.
  The admin UI generates the Slack app manifest.
- **AI agents:** teammates powered by Claude, with a name, avatar, role, team and instructions. DM them, invite them to channels, `@mention` them or
  reply in their threads. Agents can post to other channels, DM people and other agents (delegation, limited to a few hops), read channels, search
  messages, react, and optionally search the web. Choose between Claude Opus 5.5, Sonnet 5.5 and Haiku 4.5, and between "mentions only" and
  "every message" reply modes.

#### Operations

- Single-container deployment: Fastify, Socket.IO and SQLite (`node:sqlite`) on Node.js 24, with no external database.
- `docker-compose.yml` with Caddy for automatic HTTPS and an optional coturn profile.
- Automatic, append-only database migrations on startup.
- Admin CLI: `backup` (consistent online snapshot), `reset-password`, `make-owner`, `users`.
- Health endpoint at `/api/health`.
- Bearer-token authentication and configurable server URL for desktop (Electron) and mobile (Capacitor or native) clients.

[Unreleased]: https://github.com/marekbdzoch/relay/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/marekbdzoch/relay/releases/tag/v0.1.0
