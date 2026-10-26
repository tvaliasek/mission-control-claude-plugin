import { spawnSync } from "node:child_process";

import { log } from "./cli.ts";

export const MARKETPLACE_REPO = "tvaliasek/mission-control-claude-plugin";
export const PLUGIN_ID = "mission-control@mission-control";

interface RunResult {
  ok: boolean;
  output: string;
  error?: string;
}

// Runs a client CLI without passing on keys from our own environment.
const run = (command: string, args: string[], input?: string): RunResult => {
  const env = { ...process.env };
  delete env.MC_ADMIN_API_KEY;
  delete env.MC_API_KEY;
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    env,
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) {
    const { code } = result.error as NodeJS.ErrnoException;
    return {
      error: `could not run ${command}: ${code ?? result.error.message}`,
      ok: false,
      output: "",
    };
  }
  const output = `${result.stdout}${result.stderr}`.trim();
  return result.status === 0
    ? { ok: true, output }
    : {
        error: `${command} ${args.slice(0, 2).join(" ")} exited with ${result.status}`,
        ok: false,
        output,
      };
};

export const isInstalled = (command: string) => run(command, ["--version"]).ok;

const step = (result: RunResult, what: string): string | null => {
  if (result.ok) {
    log(what);
    return null;
  }
  return [result.error, result.output].filter(Boolean).join("\n");
};

export const configureClaude = (
  values: Record<string, string>
): string | null =>
  step(
    run(
      "claude",
      ["plugin", "configure", PLUGIN_ID, "--values-stdin"],
      JSON.stringify(values)
    ),
    `configured ${PLUGIN_ID} in Claude Code`
  );

export const installClaude = (): string | null =>
  step(
    run("claude", ["plugin", "marketplace", "add", MARKETPLACE_REPO]),
    "Claude Code: marketplace added"
  ) ??
  step(
    run("claude", ["plugin", "install", PLUGIN_ID]),
    "Claude Code: plugin installed"
  );

const ALREADY_REGISTERED_RE = /already registered/u;

export const installCopilot = (): string | null => {
  const added = run("copilot", [
    "plugin",
    "marketplace",
    "add",
    MARKETPLACE_REPO,
  ]);
  // unlike claude, copilot fails when the marketplace is already registered
  const marketplace =
    added.ok || ALREADY_REGISTERED_RE.test(added.output)
      ? { ok: true, output: added.output }
      : added;
  return (
    step(marketplace, "Copilot CLI: marketplace added") ??
    step(
      run("copilot", ["plugin", "install", PLUGIN_ID]),
      "Copilot CLI: plugin installed"
    )
  );
};
