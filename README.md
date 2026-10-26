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
| `mc_url` | Base URL of Mission Control, e.g. `https://mc.example.com`. Must be the hostname listed in the server's `MC_ALLOWED_HOSTS` |
| `mc_api_key` | API key. Stored in secure storage, not in `settings.json` |
| `agent_name` | Agent name this Claude Code registers as (default `claude-code`) |

To change them later, run `/plugin configure mission-control@mission-control` in Claude Code. For unattended setup, pass them at install time: `claude plugin install mission-control@mission-control --config mc_url=https://mc.example.com --config mc_api_key=... --config agent_name=build-box`.

Check the connection by asking Claude to "connect to Mission Control", or run `/mcp` and confirm `mission-control` is connected.

## Choosing an API key

The server's global `API_KEY` authenticates as **admin**: an agent holding it can manage users, backups and every other agent. Prefer an agent-scoped key for each machine:

1. Create the agent in Mission Control (UI, or let it register once with the global key).
2. As admin, issue a key for it:

   ```bash
   curl -X POST "$MC_URL/api/agents/<agent-name-or-id>/keys" \
     -H "x-api-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
     -d '{"name":"laptop","scopes":["operator"],"expires_in_days":90}'
   ```

   The response's `api_key` (`mca_…`) is shown once. Use it as `mc_api_key` and set `agent_name` to the same agent.

The default scopes (`viewer`, `agent:self`) are read-only and not enough to register, send heartbeats or poll the queue; those need `operator`. An agent-scoped key without `admin` may only poll its own queue and connect as its own agent.

## Compatibility

The MCP server is vendored unchanged from Mission Control **v2.3.0** (commit `a61ebbfb5a5bf28a8d6345c4d07134a6c3beac52`). Tools that call endpoints missing from older Mission Control versions return an HTTP error; newer versions may expose tools this copy lacks.

To update the vendored files to another tag:

```bash
TAG=v2.3.0
for f in mc-mcp-server.cjs mc-base-url.cjs; do
  curl -fsSL "https://raw.githubusercontent.com/builderz-labs/mission-control/$TAG/scripts/$f" \
    -o "plugins/mission-control/scripts/$f"
done
```

Then update the tag and commit above, bump `version` in `plugins/mission-control/.claude-plugin/plugin.json`, and run `claude plugin validate .`.

## Layout

```
.claude-plugin/marketplace.json          marketplace catalog
plugins/mission-control/
  .claude-plugin/plugin.json             manifest and user configuration
  .mcp.json                              MCP server definition
  scripts/                               vendored upstream MCP server (MIT)
  skills/mission-control/SKILL.md        agent workflow skill
```

## License

MIT, see [LICENSE](LICENSE). The files in `plugins/mission-control/scripts/` are © Builderz Labs under the MIT license in [`scripts/LICENSE.mission-control`](plugins/mission-control/scripts/LICENSE.mission-control).
