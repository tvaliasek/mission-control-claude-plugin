# Roadmap

## Done

- TypeScript toolchain: TypeScript 6, Ultracite (Oxlint + Oxfmt), Rstest, Rslib build of `mc-enroll` into one readable, committed `.cjs`. CI checks that the committed output matches a fresh build.
- Daily check for new Mission Control releases and moved release tags (`.github/workflows/upstream.yml`); vendoring is done by hand in a reviewed pull request (`npm run vendor -- vX.Y.Z`).
- Interactive setup: `npx @tvaliasek/mission-control-claude-plugin`, released to npm with provenance by `.github/workflows/release.yml` (the first version is published manually).
- GitHub Copilot CLI support: the launcher falls back to `MC_URL` / `MC_API_KEY` from the environment because Copilot has no plugin configuration (verified with Copilot CLI 1.0.103).

## Ideas

- Use Copilot CLI's secret storage if it opens `${secret:…}` or `${input:…}` to plugins (github/copilot-cli#4042); the key would then leave the shell environment.

## Next

- **TypeScript 7.** 7.x (the native compiler) is already npm `latest`; 6.x was chosen for now. TypeScript is only used for type-checking, so the move is a version bump plus fixing whatever the new checker reports.
- **Rstest 1.0.** It is still 0.x; the version is pinned exactly. Revisit pins when 1.0 ships.

## Constraints

- Plugins install from git without a build step, so build output stays committed.
- `mc-enroll` stays one dependency-free, unminified file: users are told to read it before giving it an admin key.
- The vendored upstream MCP server stays plain JavaScript with a single, marked patch applied by `scripts/vendor-upstream.ts`.
- Runtime target for shipped scripts is Node 18+; development needs Node 24+.
