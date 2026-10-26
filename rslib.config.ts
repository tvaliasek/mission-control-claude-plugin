import { defineConfig } from "@rslib/core";

// Builds our scripts into readable, dependency-free .cjs files. The plugin scripts
// are committed (plugins are installed from git without a build); the setup CLI is
// built into dist/ and published to npm.
export default defineConfig({
  lib: [
    {
      format: "cjs",
      output: { distPath: { root: "plugins/mission-control/scripts" } },
      shims: { cjs: { "import.meta.url": false } },
      source: {
        entry: {
          "mc-enroll": "./src/mc-enroll.ts",
          "mc-mcp-launch": "./src/mc-mcp-launch.ts",
        },
      },
      syntax: ["node >= 18"],
    },
    {
      format: "cjs",
      output: { distPath: { root: "dist" } },
      shims: { cjs: { "import.meta.url": false } },
      source: { entry: { setup: "./src/setup.ts" } },
      syntax: ["node >= 18"],
    },
  ],
  output: {
    // the scripts directory also holds the vendored upstream files
    cleanDistPath: false,
    // the launcher loads the vendored server at runtime instead of bundling it
    externals: { "./mc-mcp-server.cjs": "commonjs ./mc-mcp-server.cjs" },
    filename: { js: "[name].cjs" },
    minify: false,
    target: "node",
  },
});
