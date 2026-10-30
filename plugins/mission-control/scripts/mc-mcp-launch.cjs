var __webpack_modules__ = ({
"./mc-mcp-server.cjs"(module) {
"use strict";
module.exports = require("./mc-mcp-server.cjs");

},

});
// The module cache
var __webpack_module_cache__ = {};

// The require function
function __webpack_require__(moduleId) {

// Check if module is in cache
var cachedModule = __webpack_module_cache__[moduleId];
if (cachedModule !== undefined) {
return cachedModule.exports;
}
// Create a new module (and put it into the cache)
var module = (__webpack_module_cache__[moduleId] = {
exports: {}
});
// Execute the module function
__webpack_modules__[moduleId](module, module.exports, __webpack_require__);

// Return the exports of the module
return module.exports;

}

var __webpack_exports__ = {};
// This entry needs to be wrapped in an IIFE because it needs to be isolated against other modules in the chunk.
(() => {
/*
 Starts the vendored Mission Control MCP server with the right URL and API key.

 Claude Code resolves ${user_config.*} in .mcp.json into MC_URL and MC_API_KEY.
 GitHub Copilot CLI has no user configuration and passes those placeholders through
 literally, so this launcher falls back to MC_URL_FALLBACK and MC_API_KEY_FALLBACK,
 which .mcp.json fills from the user's own MC_URL and MC_API_KEY environment variables.

 Source: src/mc-mcp-launch.ts in github.com/tvaliasek/mission-control-claude-plugin
*/ // An unexpanded ${user_config.*} or ${VAR:-} reference, as a client that doesn't
// support it passes it through.
const PLACEHOLDER_RE = /^\$\{[A-Za-z_][\w.:-]*\}$/u;
const resolved = (value)=>value && !PLACEHOLDER_RE.test(value) ? value : undefined;
// URL and key are taken as a pair from one source, so a key from the shell is
// never sent to a URL from the plugin configuration or the other way round.
const pick = (url, apiKey)=>{
    const u = resolved(url);
    // fetch and Mission Control both ignore surrounding whitespace in the header
    const k = resolved(apiKey)?.trim();
    return u && k ? {
        apiKey: k,
        url: u
    } : undefined;
};
const settings = pick(process.env.MC_URL, process.env.MC_API_KEY) ?? pick(process.env.MC_URL_FALLBACK, process.env.MC_API_KEY_FALLBACK);
// Printable ASCII only: fetch rejects anything else with an error that contains the
// key, and the server would return that error to the model as tool output.
const KEY_RE = /^[!-~]+$/u;
const LOCAL_HOSTS = new Set([
    "localhost",
    "127.0.0.1",
    "[::1]"
]);
// Plain HTTP to another machine would send the key unencrypted. MC_ALLOW_HTTP set to
// that host (host:port as in the URL) opts in for that host only. Returns the refused
// host, or undefined.
const refusedPlainHttpHost = (url)=>{
    let parsed;
    try {
        parsed = new URL(url.trim());
    } catch  {
        // the server reports an invalid URL itself
        return;
    }
    const allowed = process.env.MC_ALLOW_HTTP?.trim().toLowerCase();
    return parsed.protocol === "http:" && !LOCAL_HOSTS.has(parsed.hostname) && allowed !== parsed.host ? parsed.host : undefined;
};
delete process.env.MC_URL_FALLBACK;
delete process.env.MC_API_KEY_FALLBACK;
const refusedHost = settings && refusedPlainHttpHost(settings.url);
delete process.env.MC_ALLOW_HTTP;
// Mission Control checks a session cookie before the API key, so an MC_COOKIE left in
// the shell by mc-cli would make the agent act as that logged-in user.
delete process.env.MC_COOKIE;
// The vendored server follows redirects, and fetch then sends x-api-key to the
// redirect target. Refuse every redirect instead of patching the vendored file.
const { fetch: originalFetch } = globalThis;
globalThis.fetch = async (input, init)=>{
    try {
        return await originalFetch(input, {
            ...init,
            redirect: "error"
        });
    } catch (error) {
        const { cause } = error;
        if (cause?.message === "unexpected redirect") {
            throw new Error("Mission Control answered with a redirect, which is refused so the API key is not forwarded; set the Mission Control URL to the address it redirects to", {
                cause: error
            });
        }
        throw error;
    }
};
if (settings && !KEY_RE.test(settings.apiKey)) {
    process.stderr.write("mission-control: the Mission Control API key contains invalid characters; set it again\n");
    process.exitCode = 1;
} else if (refusedHost) {
    process.stderr.write(`mission-control: the Mission Control URL uses plain HTTP to another machine, which would send the API key unencrypted; use an HTTPS URL, or set MC_ALLOW_HTTP=${refusedHost} in the environment claude or copilot starts from to allow it for that host\n`);
    process.exitCode = 1;
} else if (settings) {
    process.env.MC_URL = settings.url;
    process.env.MC_API_KEY = settings.apiKey;
    // external in rslib.config.ts: loaded from the plugin's scripts directory at runtime.
    // The build output is CommonJS (no top-level await), so load it only once env is set.
    // oxlint-disable-next-line node/global-require, unicorn/prefer-module
    __webpack_require__("./mc-mcp-server.cjs");
} else {
    process.stderr.write("mission-control: no Mission Control URL and API key. In Claude Code, run /plugin configure mission-control@mission-control. In GitHub Copilot CLI, export MC_URL and MC_API_KEY before starting copilot.\n");
    process.exitCode = 1;
}

})();

for(var __rspack_i in __webpack_exports__) {
  exports[__rspack_i] = __webpack_exports__[__rspack_i];
}
Object.defineProperty(exports, '__esModule', { value: true });
