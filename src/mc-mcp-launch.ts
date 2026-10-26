/*
 Starts the vendored Mission Control MCP server with the right URL and API key.

 Claude Code resolves ${user_config.*} in .mcp.json into MC_URL and MC_API_KEY.
 GitHub Copilot CLI has no user configuration and passes those placeholders through
 literally, so this launcher falls back to MC_URL_FALLBACK and MC_API_KEY_FALLBACK,
 which .mcp.json fills from the user's own MC_URL and MC_API_KEY environment variables.

 Source: src/mc-mcp-launch.ts in github.com/tvaliasek/mission-control-claude-plugin
*/

// An unexpanded ${user_config.*} or ${VAR:-} reference, as a client that doesn't
// support it passes it through.
const PLACEHOLDER_RE = /^\$\{[A-Za-z_][\w.:-]*\}$/u;

const resolved = (value: string | undefined): string | undefined =>
  value && !PLACEHOLDER_RE.test(value) ? value : undefined;

// URL and key are taken as a pair from one source, so a key from the shell is
// never sent to a URL from the plugin configuration or the other way round.
const pick = (url: string | undefined, apiKey: string | undefined) => {
  const u = resolved(url);
  const k = resolved(apiKey);
  return u && k ? { apiKey: k, url: u } : undefined;
};

const settings =
  pick(process.env.MC_URL, process.env.MC_API_KEY) ??
  pick(process.env.MC_URL_FALLBACK, process.env.MC_API_KEY_FALLBACK);

delete process.env.MC_URL_FALLBACK;
delete process.env.MC_API_KEY_FALLBACK;

if (settings) {
  process.env.MC_URL = settings.url;
  process.env.MC_API_KEY = settings.apiKey;
  // external in rslib.config.ts: loaded from the plugin's scripts directory at runtime.
  // The build output is CommonJS (no top-level await), so load it only once env is set.
  // oxlint-disable-next-line node/global-require, unicorn/prefer-module
  require("./mc-mcp-server.cjs");
} else {
  process.stderr.write(
    "mission-control: no Mission Control URL and API key. In Claude Code, run /plugin configure mission-control@mission-control. In GitHub Copilot CLI, export MC_URL and MC_API_KEY before starting copilot.\n"
  );
  process.exitCode = 1;
}
