# Mission Control plugin for Claude Code and GitHub Copilot CLI

Connects Claude Code or GitHub Copilot CLI to a self-hosted [Mission Control](https://github.com/builderz-labs/mission-control) instance. The `mission-control` plugin adds:

- **MCP server** `mission-control`: Mission Control's own MCP server (`scripts/mc-mcp-server.cjs`, vendored, started through a small launcher with your URL and key), with 49 `mc_*` tools for agents, tasks, comments, runs, sessions, costs, skills and the knowledge base.
- **Skill** `mission-control:mission-control`: the connect → poll queue → work → report workflow, so the agent uses the tools in the right order.

Not an official Builderz Labs project.

## Requirements

- Claude Code with plugin support, or GitHub Copilot CLI (tested with 1.0.103)
- Node.js 18 or later (the MCP server and the setup use built-in `fetch`; no npm dependencies)
- A Mission Control instance reachable from the machine, and its admin API key (or an agent key issued elsewhere)

## Setup

```bash
npx @tvaliasek/mission-control-claude-plugin@0.2.0
```

The setup asks which client to set up, the Mission Control URL and an agent name, then installs the plugin. It then issues an agent key: you type the admin API key once, it is used to register the agent and issue it an `operator`-scoped key, and it is not stored. You can paste an existing agent key instead.

- **Claude Code:** the URL, key and agent name are saved in the plugin configuration. Start a new session.
- **Copilot CLI:** the setup prints `export` lines for `MC_URL`, `MC_API_KEY` and `MC_AGENT_NAME`. Keep them in your secret store and start `copilot` with them set.

Running the setup again for an existing agent asks before issuing it another key. With Claude Code it then offers to revoke the agent's earlier keys (default no); machines still using that agent name lose access.

Check the connection with `/mcp`, or ask the agent to "connect to Mission Control".

More: [setup in detail](https://github.com/tvaliasek/mission-control-claude-plugin/blob/master/docs/setup.md), including manual install, unattended configuration and exit codes.

## Updates

Neither client updates third-party plugins on its own by default:

- **Claude Code:** enable auto-update for the `mission-control` marketplace in `/plugin` → Marketplaces, or run `claude plugin update mission-control@mission-control`.
- **Copilot CLI:** run `copilot plugin update mission-control`.

Fresh installs by setup 0.2.0 or later follow the `release` branch, which the Release workflow moves to each published release. Installs registered without `#release` (by an earlier setup or by hand) keep following `master` even when you run the setup again; moving them removes and reinstalls the plugin, including its saved settings and key. If you installed plugin 0.1.0 by hand, it asked for the server's admin key: issue an agent key and rotate the server's `API_KEY`. See [upgrading](https://github.com/tvaliasek/mission-control-claude-plugin/blob/master/docs/setup.md#upgrading).

## Plain HTTP

The plugin refuses a plain-HTTP URL to another machine, because the key would cross the network unencrypted. To allow one host, set `MC_ALLOW_HTTP` to its host and port where `claude` or `copilot` starts (for `http://mc.lan:3000`, `MC_ALLOW_HTTP=mc.lan:3000`; for a default port, only the host). The setup prints the value when you accept a plain-HTTP URL.

## Keeping the admin key off agent machines

Issue the agent key on a trusted workstation with `mc-enroll`, then paste it into the setup on the agent machine:

```bash
curl -fsSLO https://raw.githubusercontent.com/tvaliasek/mission-control-claude-plugin/v0.2.0/plugins/mission-control/scripts/mc-enroll.cjs
node mc-enroll.cjs --url https://mc.example.com --agent build-box --print
```

Read the script before giving it your admin key. Options and what the issued key can do: [mc-enroll](https://github.com/tvaliasek/mission-control-claude-plugin/blob/master/docs/setup.md#mc-enroll) and [security](https://github.com/tvaliasek/mission-control-claude-plugin/blob/master/docs/security.md).

## Security notes

- Pin the setup version rather than running whatever is latest; you type your admin key into it. Releases after 0.1.0 carry an npm provenance attestation, checked by `npm audit signatures` in a project that depends on the package. Pinning the setup does not pin the plugin, which follows the `release` branch (see [security](https://github.com/tvaliasek/mission-control-claude-plugin/blob/master/docs/security.md#package-provenance)).
- An `operator` agent key is a credential for the whole Mission Control workspace, not only its agent: it can claim unassigned tasks and change the status of any task. Rotate it if it leaks.
- With Copilot CLI the key lives in the environment, and every command the agent runs inherits it whatever you do, so use only an agent-scoped key. Setting the variables only for the `copilot` process (for example a wrapper that reads them from your secret store) keeps them out of your other shells and programs.

## Documentation

- [Setup in detail](https://github.com/tvaliasek/mission-control-claude-plugin/blob/master/docs/setup.md): what the setup does, manual install, configuration, updates, upgrading, `mc-enroll`
- [Security](https://github.com/tvaliasek/mission-control-claude-plugin/blob/master/docs/security.md): API keys and scopes, the vendored MCP server, package provenance
- [Development](https://github.com/tvaliasek/mission-control-claude-plugin/blob/master/docs/development.md): building, testing, releasing, vendoring upstream, repository layout

## License

MIT, see [LICENSE](https://github.com/tvaliasek/mission-control-claude-plugin/blob/master/LICENSE). `mc-mcp-server.cjs` and `mc-base-url.cjs` in `plugins/mission-control/scripts/` are © Builderz Labs under the MIT license in [`scripts/LICENSE.mission-control`](https://github.com/tvaliasek/mission-control-claude-plugin/blob/master/plugins/mission-control/scripts/LICENSE.mission-control).
