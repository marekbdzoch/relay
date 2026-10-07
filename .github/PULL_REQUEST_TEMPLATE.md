## Summary

<!-- What does this change and why? Link related issues, e.g. "Closes #123". -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactoring / internal
- [ ] Documentation
- [ ] Build / CI / deployment

## Checklist

- [ ] The PR title follows [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat(huddles): add noise suppression`)
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes, and new behaviour is covered by tests
- [ ] `npm run format:check` passes
- [ ] New UI strings use `t()` / `tp()` and have Czech translations in `web/src/i18n.cs.ts`
- [ ] Database changes are a **new** migration appended to `server/src/db.ts` (no applied migration was edited)
- [ ] API or socket contract changes are reflected in `shared/types.ts` and `docs/api.md`
- [ ] User-facing changes are listed under `[Unreleased]` in `CHANGELOG.md`
- [ ] The mobile layout (< 768 px) and dark mode still look right

## Screenshots / recordings

<!-- For UI changes: before / after. -->

## Notes for reviewers

<!-- Anything that needs special attention: migrations, security, performance, follow-ups. -->
