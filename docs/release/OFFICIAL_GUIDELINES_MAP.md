# Official Guidelines Map

This file maps `serial-adapter` checks to the two official sources we must follow before release/listing.

## 1) OpenClaw community plugin listing

Source:
- https://github.com/openclaw/openclaw/blob/main/docs/plugins/community.md

Required fields for submission:
- Plugin name
- npm package name
- GitHub repository URL
- One-line description
- Install command

Required listing bar:
- Package published on npmjs (installable via `openclaw plugins install <npm-spec>`)
- Source code hosted on public GitHub
- Repo includes setup/use docs and issue tracker
- Clear maintenance signal

Current mapping in this repo:
- Plugin name: `openclaw.plugin.json` -> `name`
- npm package name: `package.json` -> `name` (`serial-adapter`)
- GitHub repository URL: `package.json` -> `repository.url`
- One-line description: `package.json` -> `description`
- Install command: `openclaw plugins install serial-adapter`
- Setup/use docs: `README.md`
- Issue tracker: `package.json` -> `bugs.url`
- Maintenance signal: active commits in `git log`

## 2) npm publish requirements

Sources:
- https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/
- https://docs.npmjs.com/cli/v10/configuring-npm/package-json

Practical minimum checks:
- `package.json` has valid `name` and `version`
- README exists
- `npm publish --dry-run --access public` passes
- Account has publish rights and 2FA flow available (if enforced)

Current command gate:

```powershell
npm run self-verify
```

Interpretation:
- `publish_ready=true`: packaging/install/compliance checks are green.
- `merge_main_ready=true`: publish gate + semantic gate + hardware gate are green.
