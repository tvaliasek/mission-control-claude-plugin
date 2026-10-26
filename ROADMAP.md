# Roadmap

## Done

- TypeScript toolchain: TypeScript 6, Ultracite (Oxlint + Oxfmt), Rstest, Rslib build of `mc-enroll` into one readable, committed `.cjs`. CI checks that the committed output matches a fresh build.
- Automatic re-vendoring of the upstream MCP server on each Mission Control release (`.github/workflows/upstream.yml`).

## Next

- **GitHub Copilot CLI support.** Copilot CLI reads this repository's `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, `skills/` and `.mcp.json`, but has no equivalent of `userConfig`. Plugins cannot declare prompted inputs or secrets there: `${secret:…}` placeholders are only created by its MCP-registry install form, and `${input:…}` does not exist (github/copilot-cli#4042). Plan: fall back to `MC_URL`, `MC_API_KEY` and `MC_AGENT_NAME` from the user's environment when `${user_config.*}` is not resolved, and verify the behaviour against a real Copilot CLI install.
- **TypeScript 7.** 7.x (the native compiler) is already npm `latest`; 6.x was chosen for now. TypeScript is only used for type-checking, so the move is a version bump plus fixing whatever the new checker reports.
- **Rstest 1.0.** It is still 0.x; the version is pinned exactly. Revisit pins when 1.0 ships.

## Constraints

- Plugins install from git without a build step, so build output stays committed.
- `mc-enroll` stays one dependency-free, unminified file: users are told to read it before giving it an admin key.
- The vendored upstream MCP server stays plain JavaScript with a single, marked patch applied by `scripts/vendor-upstream.ts`.
- Runtime target for shipped scripts is Node 18+; development needs Node 24+.
