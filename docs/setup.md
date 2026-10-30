# Setup in detail

## What the setup does

```bash
npx @tvaliasek/mission-control-claude-plugin@0.2.0
```

The setup asks which of the installed clients (Claude Code, GitHub Copilot CLI) to set up, then for the Mission Control URL and an agent name. It installs the plugin, then gets an agent key in one of two ways:

- **Issue a new key** (default): you type the Mission Control admin API key once, without echo. It is used to register the agent and issue an `operator`-scoped key for it (90 days), and it is never stored. See [Choosing an API key](security.md#choosing-an-api-key) for what that key can do.
- **Paste an existing agent key**, for example one issued with [`mc-enroll --print`](#mc-enroll) on another machine. The setup checks that Mission Control accepts it.

Then:

- **Claude Code:** the URL, key and agent name are saved in the plugin configuration. The key goes to Claude Code's secure storage, not `settings.json`: the keychain on macOS; on other systems this can be a file that only your user account can read, so any program running as you can read the key. Start a new session.
- **Copilot CLI:** the `export` lines for `MC_URL`, `MC_API_KEY` and `MC_AGENT_NAME` are printed. The setup does not write them anywhere; put them where you keep secrets (see [Copilot CLI](#manual-install-in-github-copilot-cli)).
- **Earlier keys:** when it issued a key for an agent that already exists and saved it in Claude Code, the setup lists the agent's other active keys and offers to revoke them (default no). A key that is only printed for Copilot is not in use yet, so the setup does not offer it then. Revoke them only if no other machine still uses that agent name.

An agent counts as new only when Mission Control answers the registration with `registered: true`. Otherwise the setup asks whether to issue another key for the existing agent, so you do not take over another machine's agent by accident.

### Marketplace registration

The setup registers the marketplace on the `release` branch, which the Release workflow moves to each published release (see [Updates](#updates)). A marketplace that is already registered from another branch or tag is left as it is, and the setup prints how to move it. The setup stops before issuing a key when a `mission-control` marketplace from another repository, a directory or a git URL is registered, or when it cannot read Claude Code's marketplace list, because the plugin installed from there would receive the key.

### Keys from the environment

Keys can also come from `MC_ADMIN_API_KEY` or `MC_API_KEY` in the environment instead of being typed, but only together with `MC_URL` set to the same URL; otherwise the setup ignores them and asks, so a key exported for one instance is never sent to another.

### Plain-HTTP URLs

A plain-HTTP URL to another machine needs an explicit confirmation, and the plugin then connects only with `MC_ALLOW_HTTP` set to that host (see [Plain HTTP](#plain-http)).

### Exit codes

- **0:** done.
- **1:** stopped before the key was saved (a key logged as issued may still exist on the server; revoke it by its id), or the key could not be saved in Claude Code and was printed instead.
- **2:** set up, but earlier keys may still be active: the new key's id is unknown, listing or revoking them failed, or the revoke question got an invalid answer or, in a terminal, end of input. With piped input, end of input at that question answers its default (no).
- **130:** interrupted with Ctrl-C.

## Updates

Installs registered with `#release` (fresh installs by setup 0.2.0 or later, or by hand as below) follow the `release` branch of this repository. The **Release** workflow moves it to each published release tag, so work merged to `master` normally reaches them with the next release (writers can also move the branch by hand, see [security](security.md#package-provenance)). Installs registered without `#release` follow `master` until they are moved, also after the setup runs again (see [Upgrading](#upgrading)). Neither client updates third-party plugins on its own by default:

- **Claude Code:** turn on auto-update for the `mission-control` marketplace in `/plugin` → Marketplaces, or run `claude plugin update mission-control@mission-control`.
- **Copilot CLI:** run `copilot plugin update mission-control`, or set `"autoUpdate": true` on the `mission-control` entry of `extraKnownMarketplaces` in `~/.copilot/settings.json`.

## Upgrading

### From plugin 0.2.0

Plugin 0.3.0 refuses plain HTTP to another machine (see [Plain HTTP](#plain-http)). Installs registered without `#release` (by setup before 0.2.0, or by hand) follow `master`, so they receive every merged plugin change before it is released. To move one to the `release` branch, remove the marketplace (`claude plugin marketplace remove mission-control`, or `copilot plugin marketplace remove mission-control --force`), which also removes the plugin and, in Claude Code, its saved settings and key, then run the setup again.

### From plugin 0.1.0

Plugin 0.1.0 asked for "the value of API_KEY from the Mission Control server environment", which is the admin key. If you entered it, the agent has admin rights. Run the setup again (or [`mc-enroll`](#mc-enroll)) to issue an agent key, enter that key with `/plugin configure mission-control@mission-control`, and rotate the server's `API_KEY` if it was given to agent machines. Since 0.2.0 the plugin also refuses HTTP redirects (set the URL to the final address) and API keys with characters other than printable ASCII.

## Plain HTTP

The plugin refuses a plain-HTTP Mission Control URL to another machine, because the API key would cross the network unencrypted; `localhost`, `127.0.0.1` and `[::1]` are allowed. To allow it for one host, set `MC_ALLOW_HTTP` to that host and port (for `http://mc.lan:3000`, `MC_ALLOW_HTTP=mc.lan:3000`; the default port is left out, so `http://mc.lan:80` needs `MC_ALLOW_HTTP=mc.lan`) in the environment `claude` or `copilot` is started from. The setup prints the value when you accept a plain-HTTP URL.

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
export MC_API_KEY=mca_...          # an agent-scoped key, see security.md#choosing-an-api-key
export MC_AGENT_NAME=build-box
```

The key is then in the environment rather than an OS keychain. Every command the agent runs inherits it, whatever you do, so an agent that follows instructions from a task can read and send it: use only an agent-scoped key. Keep it out of shared dotfiles, and prefer setting the variables only for the `copilot` process (for example a wrapper script that reads them from your secret store and then runs `copilot`), which keeps them out of your other shells and programs. Without `MC_URL` and `MC_API_KEY`, the `mission-control` MCP server does not start; `copilot mcp list` and `/mcp` show its status.

How it works: `.mcp.json` passes both the Claude Code values (`${user_config.*}`) and the environment fallbacks (`${MC_URL:-}`, `${MC_API_KEY:-}`) to `scripts/mc-mcp-launch.cjs`. Copilot leaves `${user_config.*}` unexpanded, so the launcher uses the fallbacks, then starts the vendored server.

## mc-enroll

`scripts/mc-enroll.cjs` (Node 18+, no dependencies) issues an agent key without the setup. It uses the admin key once to register the agent and issue it a key with the `operator` scope; the admin key is read from a hidden prompt, or from `MC_ADMIN_API_KEY` when `MC_URL` is set to the same URL as `--url`, and never stored.

**Recommended: enroll from a trusted workstation**, so the admin key never touches the agent machine:

```bash
curl -fsSLO https://raw.githubusercontent.com/tvaliasek/mission-control-claude-plugin/v0.2.0/plugins/mission-control/scripts/mc-enroll.cjs
node mc-enroll.cjs --url https://mc.example.com --agent build-box --print
```

Download from a release tag (the latest is listed under the repository's tags), not a branch, and read the script before giving it your admin key. It prints only the agent key (`mca_…`). On the agent machine, run the setup and paste the key, or install the plugin and enter it as `mc_api_key` and `build-box` as `agent_name` (Copilot CLI: export it as `MC_API_KEY` and `MC_AGENT_NAME=build-box`).

**Alternative: enroll on the agent machine** (Claude Code only). Install the plugin, then run the same script without `--print`. It saves URL, agent key and agent name with `claude plugin configure mission-control@mission-control --values-stdin`. The admin key is typed on that machine, so use this only where that is acceptable. If `claude` cannot be started (for example the npm `claude.cmd` shim on Windows), the script prints the key instead and exits 1; enter it with `/plugin configure`.

Options:

- `--key-name NAME`: label of the key, default the hostname.
- `--expires-days N`: key lifetime, default 90.
- `--existing`: issue another key for an agent that already exists. Refused by default so you do not take over another machine's agent by accident.
- `--revoke-old`: once the new key is saved, revoke the agent's other active keys; machines still using them lose access. Refused with `--print`, because a printed key is not in use yet.
- `--allow-http`: permit a plain-HTTP URL to another machine, which the script otherwise refuses.

Exit codes: 0 done; 1 no key was saved (the script stopped before saving one, though a key it logged as issued may still exist server-side, or it printed the new key instead); 2 the key was saved but earlier keys may still be active.

The script never follows HTTP redirects, so the admin key goes only to the URL you gave; the plugin's MCP server refuses redirects too. To revoke a single key, send `DELETE /api/agents/<agent-id>/keys` with body `{"key_id": <id>}` and the admin key; the script prints the key id when it issues one.
