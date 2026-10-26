import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core],
  // build output and vendored upstream code are not ours to lint
  ignorePatterns: [...(core.ignorePatterns ?? []), "plugins/**/scripts/**"],
});
