# Moving from Slack: importing a Slack export

Relay can import a standard Slack workspace export, including people, channels, messages, threads, reactions, pins and files. Your team keeps its
history, and colleagues get their old messages back when they join Relay.

You need to be a Relay **owner or admin** to import. The import runs in the background: you can keep using Relay (or close the window) while it works.

## 1. Export your data from Slack

Only Slack workspace **owners and admins** can export data.

1. In Slack, click your workspace name in the top left and open **Tools & settings → Workspace settings**.
2. Click **Import/Export Data** in the top right and open the **Export** tab.
3. Choose the date range (for example **Entire history**) and click **Start Export**.
4. Slack sends you an e-mail when the export is ready. Download the ZIP file from the link in that e-mail. **Don't unpack it.**

Slack's own guide: [Export your workspace data](https://slack.com/help/articles/201658943).

### What your Slack plan includes

| Slack plan                 | What the export contains                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Free, Pro                  | Public channels only. Files are included as links (Relay downloads them during the import). On the free plan, Slack only exports the history it still shows you. |
| Business+, Enterprise Grid | Public channels, plus private channels and direct messages if your Slack org has enabled exports of all conversations. Slack may require an approval for this.   |

If your export contains public channels only, the import still works. You'll see a note saying that private channels and direct messages weren't part of
the export.

## 2. Import it into Relay

1. In Relay, open the workspace menu → **Workspace settings → Import from Slack**. You can also use the Slack step of the setup wizard.
2. Drag the ZIP file onto the page, or click to choose it.
3. Choose the options:
   - **Copy files and profile photos from Slack**: Relay downloads every file and photo into its own storage, so they keep working after you leave
     Slack. Turn this off for a much faster import. Messages then keep a link to the file in Slack instead.
   - **Import private channels**: only applies if your export contains them.
   - **Import direct messages**: only applies if your export contains them.
4. Click **Start import**. You'll see the progress and the numbers of people, channels, messages, files and reactions imported.

The upload limit for exports is 1 GB, or `MAX_UPLOAD_MB` if that is higher. Set `MAX_IMPORT_MB` on the server for bigger exports. If Relay runs
behind a reverse proxy, make sure the proxy also allows uploads of that size (for example `client_max_body_size` in nginx).

## What gets imported

| Slack                                                    | In Relay                                                                                                                                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| People                                                   | Matched to existing Relay accounts by e-mail address. Everyone else gets an **imported account** with their name, display name, title, time zone and photo.                                        |
| Deactivated Slack accounts                               | Imported as deactivated accounts, so their old messages still show their name                                                                                                                      |
| Guests (single- and multi-channel)                       | Imported as guests                                                                                                                                                                                 |
| Bots and apps                                            | Their messages are shown as app messages with the app's name. No accounts are created for them.                                                                                                    |
| Public and private channels                              | Same name, topic, description (purpose), creator, creation date, members and archived state. Slack's main channel goes into **#general**.                                                          |
| Channels that already exist here                         | Merged by name. Slack's history is placed before the messages already in the channel. A private Slack channel is never merged into a public Relay channel; it is created as `#name-slack` instead. |
| Direct messages and group DMs                            | Become the matching DM or group DM, merged with one that already exists between the same people                                                                                                    |
| Messages                                                 | Original date and time, edited marker, mentions, channel links, `@here` / `@channel`, links and formatting                                                                                         |
| Threads                                                  | Kept as threads. Replies also sent to the channel show in both places.                                                                                                                             |
| Reactions, pins                                          | Kept. Custom Slack emoji show as `:name:` unless you add an emoji with the same name in Relay.                                                                                                     |
| Files                                                    | Copied into Relay (with the option turned on). If a file can't be downloaded, the message keeps a link to it in Slack, and the import lists it under **Notes**.                                    |
| Joins, leaves, topic/purpose changes, renames, archiving | Shown as the usual small notices                                                                                                                                                                   |

**Not imported**: Slack app configurations and integrations, workflows, canvases, lists, huddle recordings, reminders, scheduled messages, user groups,
emoji images, and messages Slack doesn't include in the export.

The import doesn't disturb anybody. It sends no notifications or e-mails, creates no mentions in Activity, and doesn't wake up AI agents. All imported
history counts as already read. Everything is searchable as soon as the import finishes.

### Running the import again

Importing the same export again is safe, because nothing is duplicated. You can also import a **newer** export later (for example right before you
switch over): only the messages, reactions, people and channels that are new get added. This lets you import early, try Relay for a while, and then catch
up with a final export.

Messages that people wrote in Relay in the meantime stay where they belong by time. If imported history has to go before them, they move behind it, and
links to those Relay messages may change.

## Colleagues claim their imported accounts

Imported accounts can't sign in until their owner claims them. In **Workspace settings → Members** they show as **Not joined yet**.

To let a colleague take over their account with all their messages, channels and DMs:

1. Open **Invite people** and enter their e-mail address, **the same one they used in Slack**. You can paste many addresses at once; each gets its own
   personal link.
2. Send each person their link.
3. When they sign up through that link with that e-mail address, they choose a password and take over the imported account. All their history stays
   attached, and deactivated Slack accounts are reactivated.

Only a **personal invite created by an owner or admin** can claim an imported account. A general invite link, or an invite created by a regular member,
gets the message "This e-mail belongs to an account imported from Slack". This protects imported private channels and direct messages: nobody can take
over someone else's history just by typing their e-mail address.

People whose Slack profile had no e-mail address in the export get an account that can't be claimed. Their messages are still shown under their name.

## Using the import together with the Slack bridge

The import and the [Slack bridge](slack-bridge.md) work together. A common way to move a team step by step:

1. **Import the export first**, so Relay has the full history.
2. **Connect the bridge** and link the channels that should keep running in both apps for a while.

The bridge recognises imported people and messages. Slack users are mapped to their imported accounts, so they don't appear twice. Messages that were
imported aren't imported again when you link a channel with history, and reactions or deletions in Slack apply to the imported messages. Once everyone
has moved, unlink the channels and disconnect the bridge.

You can also do it the other way round: people the bridge already mirrored as external Slack accounts are reused by the import. They become claimable
when the export contains their e-mail address.

## Troubleshooting

- **"This file doesn't look like a Slack export"**: upload the ZIP exactly as Slack created it. A ZIP that you unpacked and packed again also works, as
  long as `users.json` and `channels.json` are inside.
- **Files show as links instead of attachments**: Slack's download links in the export expire after some time. Create a fresh export and import it
  again; Relay then downloads the files it couldn't get before and removes the links.
- **The upload stops at 100 %, or the browser shows an error for a big file**: check the upload limit of your reverse proxy (see above).
- **Only one import can run at a time.** Wait until the current one finishes before starting the next.

## For developers

- `POST /api/admin/import/slack`: multipart upload with one `.zip` file and optional fields `importFiles`, `importPrivate`, `importDms`
  (`true`/`false`, all default to `true`). Returns `{ jobId }`. Owner/admin only.
- `GET /api/admin/import/slack/:jobId` returns a `SlackImportJob` (see `shared/types.ts`). `GET /api/admin/import/slack` returns `{ job }`, the latest
  job.
- Socket events: `import:progress` (`SlackImportJob`, sent to the admin who started the import) and `import:done` (`{ jobId }`, sent to everyone; clients
  reload their data).
- Mappings from Slack ids to Relay ids are stored in the `import_map` table (`source = 'slack'`); imported accounts have `users.imported = 1`.
