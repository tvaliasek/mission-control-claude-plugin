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
npx mission-control-claude-plugin
```

The setup asks which of the installed clients (Claude Code, GitHub Copilot CLI) to set up, then for the Mission Control URL and an agent name. It installs the plugin, then gets an agent key in one of two ways:

- **Issue a new key** (default): you type the Mission Control admin API key once, without echo. It is used to register the agent and issue an `operator`-scoped key for it (90 days), and it is never stored. See [Choosing an API key](#choosing-an-api-key) for what that key can do.
- **Paste an existing agent key**, for example one issued with `mc-enroll --print` on another machine. The setup checks that Mission Control accepts it.

Then:

- **Claude Code:** the URL, key and agent name are saved in the plugin configuration (key in secure storage). Start a new session.
- **Copilot CLI:** the `export` lines for `MC_URL`, `MC_API_KEY` and `MC_AGENT_NAME` are printed. The setup does not write them anywhere; put them where you keep secrets.

Keys can also come from `MC_ADMIN_API_KEY` or `MC_API_KEY` in the environment instead of being typed. Releases after 0.1.0 are published from this repository by GitHub Actions with an [npm provenance](https://docs.npmjs.com/generating-provenance-statements) attestation; 0.1.0 itself is published manually and has none. Check signatures and provenance with `npm audit signatures` in a project that depends on the package, and pin a version (`npx mission-control-claude-plugin@<version>`) rather than running whatever is latest.

## Manual install in Claude Code

```bash
claude plugin marketplace add tvaliasek/mission-control-claude-plugin
claude plugin install mission-control@mission-control
```

Or inside a session: `/plugin marketplace add tvaliasek/mission-control-claude-plugin`, then `/plugin install mission-control@mission-control`.

When the plugin is enabled, Claude Code asks for:

| Option | Description |
| --- | --- |
| `mc_url` | Base URL of Mission Control, e.g. `https://mc.example.com`. If the server sets `MC_ALLOWED_HOSTS`, the hostname must match it |
| `mc_api_key` | API key. Stored in secure storage, not in `settings.json` |
| `agent_name` | Unique agent name for this machine. Machines sharing a name share one agent and one task queue |

To change them later, run `/plugin configure mission-control@mission-control` in Claude Code. For unattended setup, pass them at install time: `claude plugin install mission-control@mission-control --config mc_url=https://mc.example.com --config mc_api_key=... --config agent_name=build-box`.

Check the connection by asking Claude to "connect to Mission Control", or run `/mcp` and confirm `mission-control` is connected.

## Manual install in GitHub Copilot CLI

```bash
copilot plugin marketplace add tvaliasek/mission-control-claude-plugin
copilot plugin install mission-control@mission-control
```

Copilot CLI has no plugin configuration dialog: plugins cannot ask for values there, and its secret placeholders are only available to servers installed from its MCP registry ([github/copilot-cli#4042](https://github.com/github/copilot-cli/issues/4042)). The plugin therefore reads its settings from your environment when Copilot starts:

```bash
export MC_URL=https://mc.example.com
export MC_API_KEY=mca_...          # an agent-scoped key, see below
export MC_AGENT_NAME=build-box
```

The key is then in your shell environment rather than an OS keychain. Keep it out of shared dotfiles and prefer an agent-scoped key. Without `MC_URL` and `MC_API_KEY`, the `mission-control` MCP server does not start; `copilot mcp list` and `/mcp` show its status.

How it works: `.mcp.json` passes both the Claude Code values (`${user_config.*}`) and the environment fallbacks (`${MC_URL:-}`, `${MC_API_KEY:-}`) to `scripts/mc-mcp-launch.cjs`. Copilot leaves `${user_config.*}` unexpanded, so the launcher uses the fallbacks, then starts the vendored server.

## Choosing an API key

The server's global `API_KEY` authenticates as **admin**: an agent holding it can manage users, backups and every other agent. Give each machine an agent-scoped key instead. The [quick setup](#quick-setup) does this for you. To keep the admin key off the agent machine, use `scripts/mc-enroll.cjs` (Node 18+, no dependencies) instead. It uses the admin key once to register the agent and issue it a key with the `operator` scope; the admin key is read from `MC_ADMIN_API_KEY` or a hidden prompt and never stored.

**Recommended: enroll from a trusted workstation**, so the admin key never touches the agent machine:

```bash
curl -fsSLO https://raw.githubusercontent.com/tvaliasek/mission-control-claude-plugin/v0.1.0/plugins/mission-control/scripts/mc-enroll.cjs
node mc-enroll.cjs --url https://mc.example.com --agent build-box --print
```

Download from a release tag, not `master`, and read the script before giving it your admin key. It prints only the agent key (`mca_…`). On the agent machine, install the plugin and enter that key as `mc_api_key` and `build-box` as `agent_name` (Copilot CLI: export it as `MC_API_KEY` and `MC_AGENT_NAME=build-box`).

**Alternative: enroll on the agent machine** (Claude Code only). Install the plugin, then run the same script without `--print`. It saves URL, agent key and agent name with `claude plugin configure mission-control@mission-control --values-stdin`. The admin key is typed on that machine, so use this only where that is acceptable. If `claude` cannot be started (for example the npm `claude.cmd` shim on Windows), the script prints the key instead and exits 1; enter it with `/plugin configure`.

Options: `--key-name` (label, default the hostname), `--expires-days` (default 90), `--existing` (issue another key for an agent that already exists; refused by default so you do not take over another machine's agent by accident). The script never follows HTTP redirects, so the admin key goes only to the URL you gave. To revoke a key, send `DELETE /api/agents/<agent-id>/keys` with body `{"key_id": <id>}` and the admin key; the script prints the key id when it issues one.

What an `operator` agent key can do in Mission Control v2.3.0:

- It cannot use admin endpoints (users, keys, backups, settings).
- Queue polling, heartbeats, single-task updates and task comments are restricted to its own agent and the tasks assigned to it.
- Some operator endpoints do not check the agent: the queue can claim unassigned tasks, the bulk `PUT /api/tasks` can change the status of any task, and `POST /api/connect` and `/api/agents/register` accept any agent name. Treat the key as a credential for the whole workspace, not for one agent.

The default key scopes (`viewer`, `agent:self`) resolve to the read-only viewer role, which cannot connect, heartbeat or poll the queue.

## Compatibility

The MCP server is vendored unchanged from Mission Control except for one patch, marked in `loadConfig`: when `MC_URL` is set (always, under this plugin) it ignores `~/.mission-control/profiles/default.json`. Upstream falls back to a session cookie saved there by `mc-cli login`, and Mission Control checks that cookie before the API key, so the agent would act as the logged-in user and send the cookie to whatever URL is configured. Tools that call endpoints missing from older Mission Control versions return an HTTP error; newer versions may expose tools this copy lacks.

The vendored version is recorded in [`upstream.json`](upstream.json). The **Upstream release** workflow checks daily for a new Mission Control release. When there is one, it re-vendors the files at that release's commit, re-applies the patch, bumps the plugin's patch version so installed plugins update, runs all checks, and opens a pull request. If upstream changed the patched code, the workflow fails rather than shipping an unpatched server. With the default `GITHUB_TOKEN`, opening the pull request requires the repository setting _Actions → General → Allow GitHub Actions to create and approve pull requests_, and pull requests it opens do not trigger CI. To avoid both, set an `UPSTREAM_PR_TOKEN` secret (a fine-grained PAT with contents and pull-request write access). GitHub disables scheduled workflows after 60 days without repository activity; re-enable it in the Actions tab or run it manually.

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
2. The **Release** workflow checks that the tagged commit is on `master` and matches the version, runs all checks in a job without publish credentials, then a separate job (GitHub environment `npm`) publishes the tested build `mission-control-claude-plugin` to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers), with provenance and no stored npm token.

The trusted publisher is configured in the package's settings on npmjs.com, so the package must exist first: publish the first version manually (`npm run build && npm publish --access public`), then add a trusted publisher for this repository with the workflow file `release.yml` and the environment `npm`. The first publish through it must happen within 2 days. Adding required reviewers to the `npm` environment in the repository settings makes every release wait for approval.

The plugin itself is versioned separately in `plugins/mission-control/.claude-plugin/plugin.json`; Claude Code and Copilot CLI read it from the default branch.

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
