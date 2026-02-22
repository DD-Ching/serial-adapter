# CLAUDE.md

## Plugin Development Reference

This is an [OpenClaw plugin](https://docs.openclaw.ai/tools/plugin). Follow that guide for manifest format, lifecycle hooks, config schema, tool registration, and installation methods.

## Commit Convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>
```

### Types

- `feat` — new feature
- `fix` — bug fix
- `refactor` — code change that neither fixes a bug nor adds a feature
- `test` — adding or updating tests
- `docs` — documentation only
- `chore` — build, CI, deps, or other maintenance
- `perf` — performance improvement

### Scope (optional)

`python`, `ts`, `tcp`, `plugin`, `ci`

### Examples

```
feat(python): add ring buffer overflow callback
fix(ts): handle launcher timeout on slow connections
test: migrate self_test.py to pytest
chore: update uv.lock
refactor(tcp): extract common JSON serialization
```

### Rules

- Subject line: imperative mood, lowercase, no period, max 72 chars
- Body: explain **why**, not what — the diff shows what changed
- Breaking changes: add `BREAKING CHANGE:` in the body or `!` after type
