# Security

## Choosing an API key

The server's global `API_KEY` authenticates as **admin**: an agent holding it can manage users, backups and every other agent. Give each machine an agent-scoped key instead. The [setup](setup.md#what-the-setup-does) does this for you; to keep the admin key off the agent machine, issue the key on a trusted workstation with [`mc-enroll`](setup.md#mc-enroll).

What an `operator` agent key can do in Mission Control v2.3.0:

- It cannot use admin endpoints (users, keys, backups, settings).
- Queue polling, heartbeats, single-task updates and task comments are restricted to its own agent and the tasks assigned to it.
- Some operator endpoints do not check the agent: the queue can claim unassigned tasks, the bulk `PUT /api/tasks` can change the status of any task, and `POST /api/connect` and `/api/agents/register` accept any agent name. Treat the key as a credential for the whole workspace, not for one agent.

The default key scopes (`viewer`, `agent:self`) resolve to the read-only viewer role, which cannot connect, heartbeat or poll the queue.

## Where the key is kept

- **Claude Code:** secure storage, not `settings.json`: the keychain on macOS; on other systems this can be a file that only your user account can read, so any program running as you can read the key.
- **Copilot CLI:** your shell environment. Every command the agent runs inherits it; see [Copilot CLI](setup.md#manual-install-in-github-copilot-cli).

## What the plugin refuses

- Plain HTTP to another machine, unless `MC_ALLOW_HTTP` names that host ([Plain HTTP](setup.md#plain-http)).
- HTTP redirects, in the setup, `mc-enroll` and the MCP server, so the key goes only to the configured URL.
- API keys with characters other than printable ASCII.
- During setup: a `mission-control` marketplace registered from another repository, a directory or a git URL, because the plugin installed from there would receive the key.

## The vendored MCP server

The plugin runs `plugins/mission-control/scripts/mc-mcp-server.cjs`, started by `scripts/mc-mcp-launch.cjs` with your URL and key. The MCP server is vendored unchanged from Mission Control except for one patch, marked in `loadConfig`: when `MC_URL` is set (always, under this plugin) it ignores `~/.mission-control/profiles/default.json`. Upstream falls back to a session cookie saved there by `mc-cli login`, and Mission Control checks that cookie before the API key, so the agent would act as the logged-in user and send the cookie to whatever URL is configured. Tools that call endpoints missing from older Mission Control versions return an HTTP error; newer versions may expose tools this copy lacks.

How upstream changes are reviewed and vendored: [Upstream](development.md#upstream).

## Package provenance

Releases after 0.1.0 are published from this repository by GitHub Actions with an [npm provenance](https://docs.npmjs.com/generating-provenance-statements) attestation; 0.1.0 itself is published manually and has none. Check signatures and provenance with `npm audit signatures` in a project that depends on the package, and pin a version, as the setup command in the README does, rather than running whatever is latest.

Installed plugins follow the `release` branch. The Release workflow fast-forwards it to each published tag, and a repository ruleset blocks deleting it, force-pushing it or moving it backwards. Anyone with write access can still fast-forward it to any later commit, so installs trust the repository's writers, not only its releases.
