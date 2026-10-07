# Contributing to Relay

Thanks for your interest in Relay. Bug reports, translations, documentation and code are all welcome. This guide explains how to set up a development
environment and what we expect from a pull request.

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md). Please report security issues privately as described in
[SECURITY.md](SECURITY.md), not in public issues.

## Before you start

- For small fixes (typos, obvious bugs), open a pull request directly.
- For new features or larger changes, open an issue or a Discussion first so we can agree on the approach before you invest time.
- Relay is licensed under the [GNU AGPL v3 or later](LICENSE). By submitting a contribution you agree that it is licensed under the same terms.

## Development setup

Requirements:

- **Node.js 24 or newer.** The server runs TypeScript natively (type stripping), so there is no build step for it.
- npm 10+ (bundled with Node).
- Optional: Docker, if you want to test the production image.

```bash
git clone https://github.com/marekbdzoch/relay.git
cd relay
npm install
npm run dev
```

`npm run dev` starts two processes:

| Process                          | Port   | Notes                                                            |
| -------------------------------- | ------ | ---------------------------------------------------------------- |
| API server (Fastify + Socket.IO) | `3000` | Restarts automatically on file changes (`node --watch`).         |
| Web client (Vite)                | `5173` | Hot module reload; proxies `/api` and `/socket.io` to port 3000. |

Open <http://localhost:5173> and create a workspace. The first account becomes the owner.

All data (SQLite database `relay.db`, `uploads/`, the generated `.secret`) is stored in `./data`. Delete that directory to start from scratch. To point the
dev server somewhere else, set `DATA_DIR`. To proxy the web client to a different API, set `RELAY_API=http://host:port` before `npm run dev`.

Optional environment variables for local work (for example `ANTHROPIC_API_KEY` for AI agents) can be exported in your shell. See
[`.env.example`](.env.example) and [docs/deployment.md](docs/deployment.md) for the full list.

### Useful scripts

Run from the repository root:

| Command                 | What it does                                                     |
| ----------------------- | ---------------------------------------------------------------- |
| `npm run dev`           | API + web client in watch mode                                   |
| `npm run typecheck`     | `tsc --noEmit` for server and web                                |
| `npm test`              | Unit and integration tests for all workspaces                    |
| `npm run test:coverage` | The same with coverage reports                                   |
| `npm run test:e2e`      | End-to-end tests (Playwright)                                    |
| `npm run build`         | Production build of the web client into `web/dist`               |
| `npm start`             | Run the server in production mode (serves `web/dist` if present) |
| `npm run format`        | Format the repository with Prettier                              |
| `npm run format:check`  | Check formatting without writing                                 |

## Project structure

```
shared/types.ts        API contract shared by the server and all clients (REST payloads, socket events)
server/
  src/
    index.ts           entry point: HTTP server, background jobs, Slack bridge, agents
    app.ts             Fastify app factory (plugins, routes, static web client)
    config.ts          environment configuration
    db.ts              SQLite connection, migrations, query helpers
    model.ts           row types and serializers (DB row -> API object)
    services.ts        posting messages, mentions, threads, activity, the internal event bus
    realtime.ts        Socket.IO: rooms, presence, typing, huddle signalling
    jobs.ts            timers: scheduled messages, reminders, status expiry, cleanup
    unfurl.ts          link previews
    routes/            REST API grouped by area
    agents/            AI agents (Claude tool loop)
    slack/             Slack bridge (Socket Mode)
    lib/               auth, file storage, small utilities
    cli.ts             admin CLI (backup, reset-password, make-owner, users)
  test/                server tests (node:test)
web/
  src/
    main.tsx, App.tsx  bootstrapping and routing
    api.ts, socket.ts  REST client and Socket.IO client
    store.ts           Zustand store
    components/        rail, sidebar, message list, composer, panels, huddle UI
    views/             channel, DMs, activity, later, threads, search, directories
    modals/            dialogs (preferences, channel details, admin, ...)
    i18n.ts            translation helpers t() and tp()
    i18n.cs.ts         Czech translation
e2e/                   end-to-end tests (Playwright)
deploy/Caddyfile       reverse proxy configuration used by docker-compose.yml
docs/                  operator and developer documentation
```

A deeper overview is in [docs/architecture.md](docs/architecture.md).

## Coding style

- TypeScript everywhere, `strict` mode. Prefer `import type` for type-only imports. The server uses only erasable TypeScript syntax (no enums,
  namespaces or parameter properties), because Node strips types instead of compiling them. Import local files with the `.ts` extension.
- 2 spaces, single quotes, semicolons, trailing commas, lines up to about 160 columns. The [Prettier](https://prettier.io/) configuration in
  [`.prettierrc.json`](.prettierrc.json) and [`.editorconfig`](.editorconfig) encode this.
- Run `npm run format:check` before pushing. Format only the files you touched (`npx prettier --write <files>`) so unrelated diffs stay out of your PR.
- Validate request input with `zod` and the `parse()` helper; throw `HttpError` (or `badRequest()`, `notFound()`, `forbidden()`) for client errors.
- Use the `get` / `all` / `run` / `tx` helpers from `server/src/db.ts` with bound parameters. Never interpolate user input into SQL.
- Keep the API contract in `shared/types.ts` in sync when you change payloads or socket events.
- Comments explain _why_, not _what_.

## Internationalisation (i18n)

The UI is available in English and Czech. The system is gettext-style:

- **English source strings are the keys.** Wrap every user-visible string in `t()`:

  ```tsx
  import { t, tp } from '../i18n.ts';

  <button>{t('Save changes')}</button>;
  t('Joined #{channel}', { channel: name });
  ```

- **Add the Czech translation** for every new key to `web/src/i18n.cs.ts`. Missing keys fall back to English, so the UI never breaks, but please do
  not leave them untranslated. If you do not speak Czech, say so in the PR and a maintainer will help.
- **Plurals use `tp(n, one, other)`.** The `other` form is the dictionary key, `{n}` is filled in automatically:

  ```tsx
  tp(count, '{n} reply', '{n} replies');
  ```

  In `i18n.cs.ts` a plural entry is an array of `[one, few (2-4), many (5+)]`:

  ```ts
  '{n} replies': ['{n} odpověď', '{n} odpovědi', '{n} odpovědí'],
  ```

- Do not build sentences by concatenating translated fragments; use placeholders (`{name}`) instead, because word order differs between languages.
- Server error codes (e.g. `invalid_credentials`) are mapped to translated messages in the client. Do not return localized text from the API.

To add a new language, create `web/src/i18n.<code>.ts`, register it in `dictionaries` and `LANGUAGES` in `web/src/i18n.ts`, and extend `tp()` if the
language has different plural rules.

## Tests

| Workspace  | Runner                                                  | Location                     | Commands (inside the workspace)     |
| ---------- | ------------------------------------------------------- | ---------------------------- | ----------------------------------- |
| `server`   | [`node:test`](https://nodejs.org/api/test.html)         | `server/test/*.test.ts`      | `npm test`, `npm run test:coverage` |
| `web`      | [Vitest](https://vitest.dev/) + Testing Library (jsdom) | `web/src/**/*.test.{ts,tsx}` | `npm test`, `npm run test:coverage` |
| end-to-end | [Playwright](https://playwright.dev/)                   | `e2e/*.spec.ts`              | `npm run test:e2e` (from the root)  |

From the repository root, `npm test` runs the server and web suites. Run a single workspace with `npm -w server test` or `npm -w web test`.
Coverage reports are written to `server/coverage` and `web/coverage`.

Server tests use the helpers in `server/test/helpers.ts`, which build the app in-process on a fresh temporary `DATA_DIR`, so they never touch your
`./data` directory. Each test file runs in its own process, so module singletons (config, database, Socket.IO) are fresh per file.

End-to-end tests drive a real browser against a running server:

```bash
npx playwright install --with-deps chromium   # first time only
npm run test:e2e                              # runs playwright.config.ts from the repository root
npx playwright show-report                    # open the HTML report after a failure
```

The Playwright configuration lives in `playwright.config.ts` at the repository root and the specs in `e2e/`. Reports go to `playwright-report/` and
`test-results/`, which are git-ignored.

Please add or update tests for every bug fix and feature. A bug fix should come with a test that fails without the fix.

## Database migrations

The schema is managed by an append-only list of SQL migrations in `server/src/db.ts`. The current version is stored in the `schema_version` table and
pending migrations run automatically, each in its own transaction, when the server starts.

To change the schema:

1. **Append** a new string to the end of the `migrations` array, with a comment that states its number and purpose:

   ```ts
   /* 5: message bookmarks */ `
   CREATE TABLE bookmarks (...);
   ALTER TABLE channels ADD COLUMN ...;
   `,
   ```

2. **Never edit, reorder or delete a migration that has been merged.** Existing installations have already applied it and will not run it again. Fix
   mistakes with a new migration.
3. Prefer additive changes (`ADD COLUMN` with a default, new tables, new indexes). SQLite has limited `ALTER TABLE` support; for complex changes
   create a new table, copy the data and rename it, all inside the migration.
4. Update the row types and serializers in `server/src/model.ts` and the API types in `shared/types.ts`.
5. Test the migration against a copy of an existing database, not only against an empty one.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<optional scope>): <short summary in the imperative mood>

<optional body: what and why>

<optional footer: BREAKING CHANGE: ..., Closes #123>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
Common scopes: `server`, `web`, `api`, `db`, `huddles`, `agents`, `slack`, `search`, `i18n`, `docker`, `deps`.

Examples:

```
feat(huddles): show who is speaking
fix(search): match words with diacritics in file names
docs: add nginx example to deployment guide
```

Pull requests are usually squash-merged, so the PR title should follow the same format.

## Pull request checklist

Before you request a review:

- [ ] The branch is up to date with `main` and focused on one change.
- [ ] `npm run typecheck`, `npm test` and `npm run build` pass locally.
- [ ] `npm run format:check` passes for the files you changed.
- [ ] Tests cover the change.
- [ ] New UI strings use `t()` / `tp()` and have Czech translations.
- [ ] Schema changes are a new migration; no applied migration was edited.
- [ ] `shared/types.ts` and `docs/api.md` reflect any API or socket changes.
- [ ] User-facing changes are noted under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
- [ ] UI changes were checked in light and dark mode and in the mobile layout (< 768 px). Screenshots are attached.

CI runs the same checks on every pull request. A maintainer will review your PR. Please be patient and responsive to feedback.

## Releasing (maintainers)

1. Move the `[Unreleased]` entries in `CHANGELOG.md` to a new version section and update `version` in `package.json` files and `server/src/config.ts`.
2. Commit as `chore(release): vX.Y.Z`, tag `vX.Y.Z` and push the tag.
3. The `Release` workflow builds a multi-arch image (`linux/amd64`, `linux/arm64`) and pushes it to `ghcr.io/marekbdzoch/relay`.
4. Create a GitHub release from the tag with the changelog section as its notes.
