import { defineConfig } from "@rslib/core";

// Builds our scripts into readable, dependency-free .cjs files next to the vendored
// MCP server. The output is committed: plugins are installed from git without a build.
export default defineConfig({
  lib: [
    {
      format: "cjs",
      shims: { cjs: { "import.meta.url": false } },
      source: {
        entry: {
          "mc-enroll": "./src/mc-enroll.ts",
          "mc-mcp-launch": "./src/mc-mcp-launch.ts",
        },
      },
      syntax: ["node >= 18"],
    },
  ],
  output: {
    // the scripts directory also holds the vendored upstream files
    cleanDistPath: false,
    distPath: { root: "plugins/mission-control/scripts" },
    // the launcher loads the vendored server at runtime instead of bundling it
    externals: { "./mc-mcp-server.cjs": "commonjs ./mc-mcp-server.cjs" },
    filename: { js: "[name].cjs" },
    minify: false,
    target: "node",
  },
});
