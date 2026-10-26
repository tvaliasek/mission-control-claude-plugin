# Mission Control plugin for Claude Code

A Claude Code plugin marketplace with one plugin, `mission-control`, that connects Claude Code to a self-hosted [Mission Control](https://github.com/builderz-labs/mission-control) instance.

The plugin provides:

- **MCP server** `mission-control`: the upstream `scripts/mc-mcp-server.cjs` (49 `mc_*` tools for agents, tasks, comments, runs, sessions, costs, skills and the knowledge base), started with your URL and API key.
- **Skill** `mission-control:mission-control`: the connect → poll queue → work → report workflow, so the agent uses the tools in the right order.

Not an official Builderz Labs project.

## Requirements

- Claude Code with plugin support
- Node.js 18 or later on the machine running Claude Code (the MCP server uses built-in `fetch`; no npm dependencies)
- A Mission Control instance reachable over HTTP(S) from that machine, and an API key for it

## Install

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

## Choosing an API key

The server's global `API_KEY` authenticates as **admin**: an agent holding it can manage users, backups and every other agent. Give each machine an agent-scoped key instead. `scripts/mc-enroll.cjs` (Node 18+, no dependencies) uses the admin key once to register the agent and issue it a key with the `operator` scope; the admin key is read from `MC_ADMIN_API_KEY` or a hidden prompt and never stored.

**Recommended: enroll from a trusted workstation**, so the admin key never touches the agent machine:

```bash
curl -fsSLO https://raw.githubusercontent.com/tvaliasek/mission-control-claude-plugin/v0.1.0/plugins/mission-control/scripts/mc-enroll.cjs
node mc-enroll.cjs --url https://mc.example.com --agent build-box --print
```

Download from a release tag, not `main`, and read the script before giving it your admin key. It prints only the agent key (`mca_…`). On the agent machine, install the plugin and enter that key as `mc_api_key` and `build-box` as `agent_name`.

**Alternative: enroll on the agent machine.** Install the plugin, then run the same script without `--print`. It saves URL, agent key and agent name with `claude plugin configure mission-control@mission-control --values-stdin`. The admin key is typed on that machine, so use this only where that is acceptable. If `claude` cannot be started (for example the npm `claude.cmd` shim on Windows), the script prints the key instead and exits 1; enter it with `/plugin configure`.

Options: `--key-name` (label, default the hostname), `--expires-days` (default 90), `--existing` (issue another key for an agent that already exists; refused by default so you do not take over another machine's agent by accident). The script never follows HTTP redirects, so the admin key goes only to the URL you gave. To revoke a key, send `DELETE /api/agents/<agent-id>/keys` with body `{"key_id": <id>}` and the admin key; the script prints the key id when it issues one.

What an `operator` agent key can do in Mission Control v2.3.0:

- It cannot use admin endpoints (users, keys, backups, settings).
- Queue polling, heartbeats, single-task updates and task comments are restricted to its own agent and the tasks assigned to it.
- Some operator endpoints do not check the agent: the queue can claim unassigned tasks, the bulk `PUT /api/tasks` can change the status of any task, and `POST /api/connect` and `/api/agents/register` accept any agent name. Treat the key as a credential for the whole workspace, not for one agent.

The default key scopes (`viewer`, `agent:self`) resolve to the read-only viewer role, which cannot connect, heartbeat or poll the queue.

## Compatibility

The MCP server is vendored unchanged from Mission Control except for one patch, marked in `loadConfig`: when `MC_URL` is set (always, under this plugin) it ignores `~/.mission-control/profiles/default.json`. Upstream falls back to a session cookie saved there by `mc-cli login`, and Mission Control checks that cookie before the API key, so the agent would act as the logged-in user and send the cookie to whatever URL is configured. Tools that call endpoints missing from older Mission Control versions return an HTTP error; newer versions may expose tools this copy lacks.

The vendored version is recorded in [`upstream.json`](upstream.json). The **Upstream release** workflow checks daily for a new Mission Control release. When there is one, it re-vendors the files at that release's commit, re-applies the patch, bumps the plugin's patch version so installed plugins update, runs all checks, and opens a pull request. If upstream changed the patched code, the workflow fails rather than shipping an unpatched server. Pull requests opened with the default `GITHUB_TOKEN` do not trigger CI. To have CI run on them, set an `UPSTREAM_PR_TOKEN` secret (a fine-grained PAT with contents and pull-request write access).

## Development

Requires Node.js 24+. Plugins are installed straight from git without a build step, so the build output in `plugins/mission-control/scripts/` is committed. CI fails if it differs from a fresh build.

```bash
npm ci
npm run check          # typecheck, lint (Ultracite: Oxlint + Oxfmt), build (Rslib), tests (Rstest)
npm run fix            # apply lint and format fixes
npm run vendor         # re-vendor the upstream tag in upstream.json; `-- v2.4.0` or `-- --latest` to change it
```

The tests run against the built `mc-enroll.cjs`, the file users download, so `npm test` needs a prior `npm run build`.

## Layout

```
.claude-plugin/marketplace.json          marketplace catalog
plugins/mission-control/                 the plugin as installed
  .claude-plugin/plugin.json             manifest and user configuration
  .mcp.json                              MCP server definition
  scripts/                               build output (mc-enroll.cjs) and vendored upstream files
  skills/mission-control/SKILL.md        agent workflow skill
src/mc-enroll.ts                         source of scripts/mc-enroll.cjs
scripts/vendor-upstream.ts               vendors and patches the upstream MCP server
test/                                    Rstest tests
upstream.json                            vendored upstream tag and commit
```

## License

MIT, see [LICENSE](LICENSE). `mc-mcp-server.cjs` and `mc-base-url.cjs` in `plugins/mission-control/scripts/` are © Builderz Labs under the MIT license in [`scripts/LICENSE.mission-control`](plugins/mission-control/scripts/LICENSE.mission-control).
