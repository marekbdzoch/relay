# Slack bridge

The Slack bridge connects selected Relay channels with channels in an existing Slack workspace. Your team works in Relay, while partners, customers or
colleagues who stay on Slack keep using Slack. Linked channels are mirrored in both directions.

## What gets synchronised

|                        | Slack → Relay                                                                                                    | Relay → Slack                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Messages               | Shown under the Slack user's name and photo, with a **Slack** badge                                              | Posted with the Relay author's name and photo             |
| Threads                | yes                                                                                                              | yes                                                       |
| "Also send to channel" | yes                                                                                                              | yes                                                       |
| Edits and deletions    | yes                                                                                                              | yes                                                       |
| Reactions              | yes, by the Slack user                                                                                           | yes, but shown as the bot's reaction in Slack             |
| Files                  | yes, up to `MAX_UPLOAD_MB`                                                                                       | yes                                                       |
| Mentions               | Slack mentions of matched users become Relay mentions; typing `@relayusername` in Slack mentions that Relay user | Relay mentions of Slack people become real Slack mentions |
| Profile changes        | Name, title, photo and status of Slack users are kept up to date                                                 | -                                                         |
| Channel renames        | the Slack channel name shown for the link is updated                                                             | -                                                         |

People on Slack appear in Relay as **external guest accounts** that cannot sign in. If a Slack user's e-mail address matches an existing Relay
account, their Slack messages are attributed to that account instead. This requires the `users:read.email` scope.

## Cost and requirements

- **No cost.** The bridge uses a custom Slack app, which works on the free Slack plan. On the free plan, the app counts towards the limit of 10 apps
  and integrations.
- **No public URL needed.** The bridge uses [Socket Mode](https://api.slack.com/apis/socket-mode): Relay opens an outbound WebSocket to Slack.
- A Slack workspace admin must allow installing the app (depending on workspace settings).
- For Relay profile photos to show in Slack, `PUBLIC_URL` must be set and reachable from the internet, because Slack downloads the photos from Relay.

## Setup

You need to be a Relay workspace owner or admin.

1. In Relay, open **workspace menu → Integrations & webhooks → Slack bridge**. The page shows a ready-made **app manifest**.
2. Create the Slack app from the manifest. The page offers a one-click link, or do it manually: open <https://api.slack.com/apps>, choose
   **Create New App → From a manifest**, pick your Slack workspace, paste the manifest and create the app.
3. **Install the app** to the workspace (**Install App → Install to Workspace**) and copy the **Bot User OAuth Token** (`xoxb-…`).
4. Create an **app-level token**: **Basic Information → App-Level Tokens → Generate Token and Scopes**, add the `connections:write` scope and copy the
   token (`xapp-…`).
5. Paste both tokens into Relay and save. The status changes to **Connected** with the Slack workspace name.
6. **Link channels:** for each Relay channel, pick the Slack channel to mirror and optionally import the most recent 50-500 Slack messages
   (including thread replies).
   - Public Slack channels: the app joins automatically.
   - Private Slack channels: first invite the app in Slack with `/invite @Relay`, then link.

Each Relay channel can be linked to one Slack channel and vice versa. Only public and private channels can be linked, not DMs. Unlinking stops the
sync; already mirrored messages stay in both places.

Instead of entering the tokens in the UI, you can set `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in `.env`. Environment variables take precedence.
Tokens entered in the UI are stored in the `settings` table of the Relay database.

## Manifest, scopes and events

The manifest is generated by the server (`SLACK_MANIFEST` in `server/src/slack/bridge.ts`). It creates a bot user called "Relay" with Socket Mode
enabled and interactivity disabled.

| Bot scope                            | Why it is needed                                                     |
| ------------------------------------ | -------------------------------------------------------------------- |
| `channels:history`, `groups:history` | Receive messages and import history from public and private channels |
| `channels:read`, `groups:read`       | List channels for linking and read channel details                   |
| `channels:join`                      | Join public channels when they are linked                            |
| `chat:write`                         | Post messages from Relay                                             |
| `chat:write.customize`               | Post under the Relay author's name and photo instead of the bot's    |
| `files:read`, `files:write`          | Copy files in both directions                                        |
| `reactions:read`, `reactions:write`  | Mirror reactions                                                     |
| `users:read`                         | Names, photos and profiles of Slack users                            |
| `users:read.email`                   | Match Slack users to existing Relay accounts by e-mail               |

Bot events: `message.channels`, `message.groups`, `reaction_added`, `reaction_removed`, `user_change`, `channel_rename`, `group_rename`.

The app-level token needs `connections:write` for Socket Mode.

## How it works

- Relay keeps a mapping between Relay message IDs and Slack message timestamps (`slack_messages`), so threads, edits, deletions and reactions find
  their counterpart.
- Messages that arrive from Slack are marked with their origin and are never sent back, so there are no echo loops. Messages posted by the bridge's
  own bot are ignored on the way in.
- Outgoing operations are queued per Slack channel. This keeps the order of messages and stays within Slack's rate limits.
- If the connection drops, Relay reconnects automatically with increasing delays (up to one minute). The status in the admin UI shows the last
  error.

See [architecture.md](architecture.md#slack-bridge) for more detail.

## Limitations

- **Direct messages are not bridged**, only channels.
- **Reactions** added in Relay appear in Slack as reactions of the Relay bot, because Slack apps cannot react on behalf of other users.
- Relay messages appear in Slack as app messages (with an "APP" label) under the author's name. Slack people cannot DM Relay users through the bridge.
- **Profile photos** of Relay users only show in Slack when `PUBLIC_URL` is publicly reachable. Otherwise Slack shows the app's icon.
- **History import** is limited to the latest 500 messages per channel. On the free Slack plan, Slack itself only exposes recent history.
- Files larger than `MAX_UPLOAD_MB` are not copied from Slack.
- Slack-specific content such as Block Kit layouts, huddles, canvases, workflows and polls is not mirrored; only the message text and files are.
- Pins, topics and channel membership are not synchronised. System messages (joins, leaves, topic changes) are ignored.
- Editing and deleting a message in Slack is mirrored only for messages that were bridged while the link was active.

## Troubleshooting

| Problem                                             | What to check                                                                                                                                            |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status shows `invalid_auth` or `not_authed`         | The bot token is wrong or the app was uninstalled. Reinstall and paste the new `xoxb-` token.                                                            |
| Status shows an error about `apps.connections.open` | The app-level token is wrong or lacks `connections:write`, or Socket Mode is disabled in the app settings.                                               |
| Linking a private channel fails                     | Invite the app in Slack (`/invite @Relay`) first.                                                                                                        |
| Messages from Slack do not arrive                   | Check that the event subscriptions from the manifest are present and the app was reinstalled after changing scopes. Server logs show `[slack]` messages. |
| Relay authors show the bot's icon in Slack          | Set `PUBLIC_URL` and make sure `https://<your-domain>/api/public/avatars/…` is reachable from the internet.                                              |
