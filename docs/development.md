# Development

Requires Node.js 24+. Plugins are installed straight from git without a build step, so the build output in `plugins/mission-control/scripts/` is committed. CI fails if it differs from a fresh build.

```bash
npm ci
npm run check          # typecheck, lint (Ultracite: Oxlint + Oxfmt), build (Rslib), tests (Rstest)
npm run fix            # apply lint and format fixes
npm run vendor         # re-vendor the upstream tag in upstream.json; `-- v2.4.0` or `-- --latest` to change it
```

The tests run against the built files in `plugins/mission-control/scripts/` and `dist/`, the files users get, so `npm test` needs a prior `npm run build`.

## Plugin version

The plugin is versioned separately from the npm package, in `plugins/mission-control/.claude-plugin/plugin.json`; Claude Code and Copilot CLI update installed plugins only when that version changes. Bump it in every pull request that changes `plugins/`; CI fails otherwise. Plugin changes reach installs that follow `release` with the next release, so release after merging them; installs registered without `#release` follow `master` and get them on merge.

## Releasing

1. Bump `version` in `package.json`, and the version in the `npx …@X.Y.Z` setup commands and the `vX.Y.Z` `mc-enroll` download URLs in `README.md` and `docs/setup.md`, commit, and push a matching annotated tag from `master`: `git tag -a v0.2.0 -m v0.2.0 && git push origin v0.2.0`.
2. The **Release** workflow checks that the tagged commit is on `master` and matches the version, and runs all checks in a job without publish credentials. A separate job (GitHub environment `npm`) publishes the tested build `@tvaliasek/mission-control-claude-plugin` to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers), with provenance and no stored npm token.
3. A last job fast-forwards the `release` branch, which installed plugins follow, to the tag. It refuses to move the branch backwards (a repository ruleset also blocks deleting or force-pushing `release`), so a tag older than the branch publishes to npm but fails this job. If the job fails, move the branch yourself: `git push origin "vX.Y.Z^{commit}:refs/heads/release"`.

To withdraw a bad plugin release, release a fix: revert on `master`, bump the plugin version, tag. Do not move `release` back by hand: that serves a plugin version installs already had, and the clients are not known to move back to it.

### Trusted publisher

The trusted publisher is configured in the package's settings on npmjs.com, so the package must exist first: publish the first version manually (`npm run build && npm publish --access public`), then add a trusted publisher for this repository with the workflow file `release.yml` and the environment `npm`, and under "Allowed actions" let it run `npm publish`, not only `npm stage publish`. The v0.2.0 publish failed with `E403 OIDC permission denied for this action` until the trusted publisher settings were changed; the same error may also come from a mismatched repository, workflow or environment. The first publish through it must happen within 2 days. Adding required reviewers to the `npm` environment in the repository settings makes every release wait for approval. The environment's deployment policy must allow tags matching `v*`, because the workflow runs on tag pushes. Once publishing through it works, consider setting the package's publishing access on npmjs.com to require two-factor authentication and disallow tokens, so a leaked npm token cannot publish a version without provenance.

## Upstream

The vendored Mission Control version is recorded in [`upstream.json`](../upstream.json). The **Upstream release** workflow checks daily, without running any upstream code, whether Mission Control published a newer release or moved the vendored tag to another commit, and fails the run when it did (GitHub emails the failure).

Vendoring is done by hand in a pull request, so upstream changes are reviewed (by convention: no rule on `master` requires a pull request or passing checks): `npm run vendor -- vX.Y.Z` re-vendors the files at that release's commit, re-applies the patch (see [the vendored MCP server](security.md#the-vendored-mcp-server)) and bumps the plugin's patch version so installed plugins update; CI checks the result. If upstream changed the patched code, the script fails rather than produce an unpatched server. The script never downgrades and refuses the vendored tag once upstream moved it to another commit (a possible upstream compromise). To take a moved tag or roll back on purpose after checking upstream, set `tag` and `commit` in `upstream.json` by hand, run `npm run vendor` and bump the plugin version.

GitHub disables scheduled workflows after 60 days without repository activity; re-enable it in the Actions tab or run it manually.

## Layout

```
.claude-plugin/marketplace.json          marketplace catalog
plugins/mission-control/                 the plugin as installed
  .claude-plugin/plugin.json             manifest and user configuration
  .mcp.json                              MCP server definition
  scripts/                               build output (mc-enroll.cjs, mc-mcp-launch.cjs) and vendored upstream files
  skills/mission-control/SKILL.md        agent workflow skill
src/                                     sources of the built scripts and the setup CLI
dist/setup.cjs                           built setup CLI, published to npm (not committed)
scripts/vendor-upstream.ts               vendors and patches the upstream MCP server
docs/                                    detailed documentation
test/                                    Rstest tests
upstream.json                            vendored upstream tag and commit
```
