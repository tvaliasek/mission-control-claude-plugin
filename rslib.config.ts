import { defineConfig } from "@rslib/core";

// Builds mc-enroll into one readable, dependency-free .cjs next to the vendored
// MCP server. The output is committed: plugins are installed from git without a build.
export default defineConfig({
  lib: [
    {
      format: "cjs",
      shims: { cjs: { "import.meta.url": false } },
      source: { entry: { "mc-enroll": "./src/mc-enroll.ts" } },
      syntax: ["node >= 18"],
    },
  ],
  output: {
    // the scripts directory also holds the vendored upstream files
    cleanDistPath: false,
    distPath: { root: "plugins/mission-control/scripts" },
    filename: { js: "[name].cjs" },
    minify: false,
    target: "node",
  },
});
