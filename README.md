# Mission Control plugin for Claude Code and GitHub Copilot CLI

A plugin marketplace with one plugin, `mission-control`, that connects Claude Code or GitHub Copilot CLI to a self-hosted [Mission Control](https://github.com/builderz-labs/mission-control) instance.

The plugin provides:

- **MCP server** `mission-control`: the upstream `scripts/mc-mcp-server.cjs` (49 `mc_*` tools for agents, tasks, comments, runs, sessions, costs, skills and the knowledge base), started through a small launcher (`scripts/mc-mcp-launch.cjs`) with your URL and API key.
- **Skill** `mission-control:mission-control`: the connect → poll queue → work → report workflow, so the agent uses the tools in the right order.

Not an official Builderz Labs project.

## Requirements

- Claude Code with plugin support, or GitHub Copilot CLI (tested with 1.0.103)
- Node.js 18 or later on that machine (the MCP server and setup use built-in `fetch`; no npm dependencies)
- A Mission Control instance reachable over HTTP(S) from that machine, and an API key for it

## Quick setup

```bash
npx @tvaliasek/mission-control-claude-plugin
```

The setup asks which of the installed clients (Claude Code, GitHub Copilot CLI) to set up, then for the Mission Control URL and an agent name. It installs the plugin, then gets an agent key in one of two ways:

- **Issue a new key** (default): you type the Mission Control admin API key once, without echo. It is used to register the agent and issue an `operator`-scoped key for it (90 days), and it is never stored. See [Choosing an API key](#choosing-an-api-key) for what that key can do.
- **Paste an existing agent key**, for example one issued with `mc-enroll --print` on another machine. The setup checks that Mission Control accepts it.

Then:

- **Claude Code:** the URL, key and agent name are saved in the plugin configuration. The key goes to Claude Code's secure storage, not `settings.json`: the keychain on macOS; on other systems this can be a file that only your user account can read, so any program running as you can read the key. Start a new session.
- **Copilot CLI:** the `export` lines for `MC_URL`, `MC_API_KEY` and `MC_AGENT_NAME` are printed. The setup does not write them anywhere; put them where you keep secrets.
- **Earlier keys:** when it issued a key for an agent that already exists and saved it in Claude Code, the setup lists the agent's other active keys and offers to revoke them (default no). A key that is only printed for Copilot is not in use yet, so the setup does not offer it then. When earlier keys may still be active because listing or revoking them failed, or that question got an invalid answer or, in a terminal, end of input, the setup exits 2. Revoke them only if no other machine still uses that agent name.

The setup registers the marketplace on the `release` branch, which only moves to published releases (see [Updates](#updates)). A marketplace that is already registered from another branch or tag is left as it is, and the setup prints how to move it. The setup stops before issuing a key when a `mission-control` marketplace from another repository, a directory or a git URL is registered, or when it cannot read Claude Code's marketplace list, because the plugin installed from there would receive the key.

Keys can also come from `MC_ADMIN_API_KEY` or `MC_API_KEY` in the environment instead of being typed, but only together with `MC_URL` set to the same URL; otherwise the setup ignores them and asks, so a key exported for one instance is never sent to another. A plain-HTTP URL to another machine needs an explicit confirmation, and the plugin then connects only with `MC_ALLOW_HTTP` set to that host (see [Plain HTTP](#plain-http)). Releases after 0.1.0 are published from this repository by GitHub Actions with an [npm provenance](https://docs.npmjs.com/generating-provenance-statements) attestation; 0.1.0 itself is published manually and has none. Check signatures and provenance with `npm audit signatures` in a project that depends on the package, and pin a version (`npx @tvaliasek/mission-control-claude-plugin@<version>`) rather than running whatever is latest.

### Updates

Installs made by the setup from npm version 0.2.0 on, or with `#release` as below, follow the `release` branch of this repository, which the **Release** workflow moves to each published release tag; work merged to `master` reaches them only with the next release. Earlier installs follow `master` until they are moved (see [Upgrading from plugin 0.2.0](#upgrading-from-plugin-020)). Neither client updates third-party plugins on its own by default:

- **Claude Code:** turn on auto-update for the `mission-control` marketplace in `/plugin` → Marketplaces, or run `claude plugin update mission-control@mission-control`.
- **Copilot CLI:** run `copilot plugin update mission-control`, or set `"autoUpdate": true` on the `mission-control` entry of `extraKnownMarketplaces` in `~/.copilot/settings.json`.

### Plain HTTP

The plugin refuses a plain-HTTP Mission Control URL to another machine, because the API key would cross the network unencrypted; `localhost`, `127.0.0.1` and `[::1]` are allowed. To allow it for one host, set `MC_ALLOW_HTTP` to that host and port (for `http://mc.lan:3000`, `MC_ALLOW_HTTP=mc.lan:3000`; the default port is left out, so `http://mc.lan:80` needs `MC_ALLOW_HTTP=mc.lan`) in the environment `claude` or `copilot` is started from. The setup prints the value when you accept a plain-HTTP URL.

### Upgrading from plugin 0.2.0

Plugin 0.3.0 refuses plain HTTP to another machine (see [Plain HTTP](#plain-http)). Installs made before it follow `master`, so they receive every merged plugin change before it is released. To move one to the `release` branch, remove the marketplace (`claude plugin marketplace remove mission-control`, or `copilot plugin marketplace remove mission-control --force`), which also removes the plugin and, in Claude Code, its saved settings and key, then run the setup again.

### Upgrading from plugin 0.1.0

Plugin 0.1.0 asked for "the value of API_KEY from the Mission Control server environment", which is the admin key. If you entered it, the agent has admin rights. Run the setup again (or `mc-enroll`) to issue an agent key, enter that key with `/plugin configure mission-control@mission-control`, and rotate the server's `API_KEY` if it was given to agent machines. Since 0.2.0 the plugin also refuses HTTP redirects (set the URL to the final address) and API keys with characters other than printable ASCII.

## Manual install in Claude Code

```bash
claude plugin marketplace add tvaliasek/mission-control-claude-plugin#release
claude plugin install mission-control@mission-control
```

Or inside a session: `/plugin marketplace add tvaliasek/mission-control-claude-plugin#release`, then `/plugin install mission-control@mission-control`. Without `#release` the plugin follows `master`, including changes not yet released.

When the plugin is enabled, Claude Code asks for:

| Option | Description |
| --- | --- |
| `mc_url` | Base URL of Mission Control, e.g. `https://mc.example.com`. If the server sets `MC_ALLOWED_HOSTS`, the hostname must match it |
| `mc_api_key` | API key. Stored in secure storage, not in `settings.json` |
| `agent_name` | Unique agent name for this machine. Machines sharing a name share one agent and one task queue |

To change them later, run `/plugin configure mission-control@mission-control` in Claude Code. For unattended setup, install the plugin, then pipe the values as JSON to `claude plugin configure mission-control@mission-control --values-stdin`, for example from a file only you can read: `claude plugin configure mission-control@mission-control --values-stdin < mc-config.json` with `{"mc_url": "https://mc.example.com", "mc_api_key": "mca_...", "agent_name": "build-box"}`. Do not pass the key with `--config mc_api_key=...`: command-line arguments end up in shell history and are visible to other users in the process list.

Check the connection by asking Claude to "connect to Mission Control", or run `/mcp` and confirm `mission-control` is connected.

## Manual install in GitHub Copilot CLI

```bash
copilot plugin marketplace add tvaliasek/mission-control-claude-plugin#release
copilot plugin install mission-control@mission-control
```

Copilot CLI has no plugin configuration dialog: plugins cannot ask for values there, and its secret placeholders are only available to servers installed from its MCP registry ([github/copilot-cli#4042](https://github.com/github/copilot-cli/issues/4042)). The plugin therefore reads its settings from your environment when Copilot starts:

```bash
export MC_URL=https://mc.example.com
export MC_API_KEY=mca_...          # an agent-scoped key, see below
export MC_AGENT_NAME=build-box
```

The key is then in your shell environment rather than an OS keychain. Every command the agent runs in that shell inherits it, so an agent that follows instructions from a task can read and send it. Keep it out of shared dotfiles, use only an agent-scoped key, and prefer setting the variables only for the `copilot` process (for example a wrapper script that reads them from your secret store and then runs `copilot`). Without `MC_URL` and `MC_API_KEY`, the `mission-control` MCP server does not start; `copilot mcp list` and `/mcp` show its status.

How it works: `.mcp.json` passes both the Claude Code values (`${user_config.*}`) and the environment fallbacks (`${MC_URL:-}`, `${MC_API_KEY:-}`) to `scripts/mc-mcp-launch.cjs`. Copilot leaves `${user_config.*}` unexpanded, so the launcher uses the fallbacks, then starts the vendored server.

## Choosing an API key

The server's global `API_KEY` authenticates as **admin**: an agent holding it can manage users, backups and every other agent. Give each machine an agent-scoped key instead. The [quick setup](#quick-setup) does this for you. To keep the admin key off the agent machine, use `scripts/mc-enroll.cjs` (Node 18+, no dependencies) instead. It uses the admin key once to register the agent and issue it a key with the `operator` scope; the admin key is read from a hidden prompt, or from `MC_ADMIN_API_KEY` when `MC_URL` is set to the same URL as `--url`, and never stored.

**Recommended: enroll from a trusted workstation**, so the admin key never touches the agent machine:

```bash
curl -fsSLO https://raw.githubusercontent.com/tvaliasek/mission-control-claude-plugin/v0.2.0/plugins/mission-control/scripts/mc-enroll.cjs
node mc-enroll.cjs --url https://mc.example.com --agent build-box --print
```

Download from a release tag (the latest is listed under the repository's tags), not a branch, and read the script before giving it your admin key. It prints only the agent key (`mca_…`). On the agent machine, install the plugin and enter that key as `mc_api_key` and `build-box` as `agent_name` (Copilot CLI: export it as `MC_API_KEY` and `MC_AGENT_NAME=build-box`).

**Alternative: enroll on the agent machine** (Claude Code only). Install the plugin, then run the same script without `--print`. It saves URL, agent key and agent name with `claude plugin configure mission-control@mission-control --values-stdin`. The admin key is typed on that machine, so use this only where that is acceptable. If `claude` cannot be started (for example the npm `claude.cmd` shim on Windows), the script prints the key instead and exits 1; enter it with `/plugin configure`.

Options: `--key-name` (label, default the hostname), `--expires-days` (default 90), `--existing` (issue another key for an agent that already exists; refused by default so you do not take over another machine's agent by accident), `--revoke-old` (once the new key is saved, revoke the agent's other active keys; machines still using them lose access; refused with `--print`, because a printed key is not in use yet; exits 2 if a key may still be active; exit 1 means no key was saved: the script stopped before saving one (a key it logged as issued may still exist server-side) or printed the new key instead). `--allow-http` permits a plain-HTTP URL to another machine, which the script otherwise refuses. The script never follows HTTP redirects, so the admin key goes only to the URL you gave; the plugin's MCP server refuses redirects too. To revoke a single key, send `DELETE /api/agents/<agent-id>/keys` with body `{"key_id": <id>}` and the admin key; the script prints the key id when it issues one.

What an `operator` agent key can do in Mission Control v2.3.0:

- It cannot use admin endpoints (users, keys, backups, settings).
- Queue polling, heartbeats, single-task updates and task comments are restricted to its own agent and the tasks assigned to it.
- Some operator endpoints do not check the agent: the queue can claim unassigned tasks, the bulk `PUT /api/tasks` can change the status of any task, and `POST /api/connect` and `/api/agents/register` accept any agent name. Treat the key as a credential for the whole workspace, not for one agent.

The default key scopes (`viewer`, `agent:self`) resolve to the read-only viewer role, which cannot connect, heartbeat or poll the queue.

## Compatibility

The MCP server is vendored unchanged from Mission Control except for one patch, marked in `loadConfig`: when `MC_URL` is set (always, under this plugin) it ignores `~/.mission-control/profiles/default.json`. Upstream falls back to a session cookie saved there by `mc-cli login`, and Mission Control checks that cookie before the API key, so the agent would act as the logged-in user and send the cookie to whatever URL is configured. Tools that call endpoints missing from older Mission Control versions return an HTTP error; newer versions may expose tools this copy lacks.

The vendored version is recorded in [`upstream.json`](upstream.json). The **Upstream release** workflow checks daily, without running any upstream code, whether Mission Control published a newer release or moved the vendored tag to another commit, and fails the run when it did (GitHub emails the failure). Vendoring is done by hand in a pull request, so every upstream change is reviewed: `npm run vendor -- vX.Y.Z` re-vendors the files at that release's commit, re-applies the patch and bumps the plugin's patch version so installed plugins update; CI checks the result. If upstream changed the patched code, the script fails rather than produce an unpatched server. The script never downgrades and refuses the vendored tag once upstream moved it to another commit (a possible upstream compromise). To take a moved tag or roll back on purpose after checking upstream, set `tag` and `commit` in `upstream.json` by hand, run `npm run vendor` and bump the plugin version. GitHub disables scheduled workflows after 60 days without repository activity; re-enable it in the Actions tab or run it manually.

## Development

Requires Node.js 24+. Plugins are installed straight from git without a build step, so the build output in `plugins/mission-control/scripts/` is committed. CI fails if it differs from a fresh build.

```bash
npm ci
npm run check          # typecheck, lint (Ultracite: Oxlint + Oxfmt), build (Rslib), tests (Rstest)
npm run fix            # apply lint and format fixes
npm run vendor         # re-vendor the upstream tag in upstream.json; `-- v2.4.0` or `-- --latest` to change it
```

The tests run against the built files in `plugins/mission-control/scripts/` and `dist/`, the files users get, so `npm test` needs a prior `npm run build`.

### Releasing

1. Bump `version` in `package.json`, commit, and push a matching tag: `git tag v0.2.0 && git push origin v0.2.0`.
2. The **Release** workflow checks that the tagged commit is on `master` and matches the version, runs all checks in a job without publish credentials, then a separate job (GitHub environment `npm`) publishes the tested build `@tvaliasek/mission-control-claude-plugin` to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers), with provenance and no stored npm token.
3. A last job fast-forwards the `release` branch, which installed plugins follow, to the tag. It refuses to move the branch backwards (a repository ruleset also blocks deleting or force-pushing `release`), so a tag older than the branch publishes to npm but fails this job. A release that changes files under `.github/workflows/` most likely fails this job too, because GitHub does not let the workflow token push workflow changes; v0.2.0 is one. If the job fails, move the branch yourself: `git push origin "v0.2.0^{commit}:refs/heads/release"`.

To withdraw a bad plugin release, release a fix: revert on `master`, bump the plugin version, tag. Do not move `release` back by hand: that serves a plugin version installs already had, and the clients are not known to move back to it.

The trusted publisher is configured in the package's settings on npmjs.com, so the package must exist first: publish the first version manually (`npm run build && npm publish --access public`), then add a trusted publisher for this repository with the workflow file `release.yml` and the environment `npm`. The first publish through it must happen within 2 days. Adding required reviewers to the `npm` environment in the repository settings makes every release wait for approval.

The plugin itself is versioned separately in `plugins/mission-control/.claude-plugin/plugin.json`; Claude Code and Copilot CLI update installed plugins only when that version changes. Bump it in every pull request that changes `plugins/`; CI fails otherwise. Plugin changes reach installs that follow `release` only through a release, so release after merging them; installs made by earlier setup versions follow `master` and get them on merge.

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
test/                                    Rstest tests
upstream.json                            vendored upstream tag and commit
```

## License

MIT, see [LICENSE](LICENSE). `mc-mcp-server.cjs` and `mc-base-url.cjs` in `plugins/mission-control/scripts/` are © Builderz Labs under the MIT license in [`scripts/LICENSE.mission-control`](plugins/mission-control/scripts/LICENSE.mission-control).
