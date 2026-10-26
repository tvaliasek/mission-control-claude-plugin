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
 literally, so the server falls back to MC_URL_FALLBACK and MC_API_KEY_FALLBACK,
 which .mcp.json fills from the user's own MC_URL and MC_API_KEY environment variables.

 Source: src/mc-mcp-launch.ts in github.com/tvaliasek/mission-control-claude-plugin
*/ const resolved = (value)=>value && !value.includes("${") ? value : undefined;
const url = resolved(process.env.MC_URL) ?? resolved(process.env.MC_URL_FALLBACK);
const apiKey = resolved(process.env.MC_API_KEY) ?? resolved(process.env.MC_API_KEY_FALLBACK);
if (url && apiKey) {
    process.env.MC_URL = url;
    process.env.MC_API_KEY = apiKey;
    delete process.env.MC_URL_FALLBACK;
    delete process.env.MC_API_KEY_FALLBACK;
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
