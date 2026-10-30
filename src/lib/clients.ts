import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { log } from "./cli.ts";

export const MARKETPLACE_REPO = "tvaliasek/mission-control-claude-plugin";
const MARKETPLACE_NAME = "mission-control";
// The release workflow fast-forwards this branch to each published tag, so installs
// get releases through plugin updates and never unreleased commits from master.
const MARKETPLACE_REF = "release";
const PINNED_SOURCE = `${MARKETPLACE_REPO}#${MARKETPLACE_REF}`;
export const PLUGIN_ID = `mission-control@${MARKETPLACE_NAME}`;
// marketplace add clones a git repository, so allow for a slow network
const CLIENT_TIMEOUT_MS = 300_000;

interface RunResult {
  ok: boolean;
  output: string;
  stdout: string;
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
    timeout: CLIENT_TIMEOUT_MS,
  });
  if (result.error) {
    const { code } = result.error as NodeJS.ErrnoException;
    return {
      error: `could not run ${command}: ${code ?? result.error.message}`,
      ok: false,
      output: "",
      stdout: "",
    };
  }
  const { stdout } = result;
  const output = `${stdout}${result.stderr}`.trim();
  return result.status === 0
    ? { ok: true, output, stdout }
    : {
        error: `${command} ${args.slice(0, 2).join(" ")} exited with ${result.status}`,
        ok: false,
        output,
        stdout,
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

interface MarketplaceSource {
  repo?: unknown;
  ref?: unknown;
}

// undefined: not registered; null: could not be told
type Registered = MarketplaceSource | undefined | null;

const ALREADY_REGISTERED_RE = /already registered/u;
const EXTRA_KNOWN_RE = /extraKnownMarketplaces/u;

const removeCommand = (client: "claude" | "copilot") =>
  `${client} plugin marketplace remove ${MARKETPLACE_NAME}${client === "copilot" ? " --force" : ""}`;

const claudeMarketplace = (): Registered => {
  const listed = run("claude", ["plugin", "marketplace", "list", "--json"]);
  try {
    const entries = JSON.parse(listed.stdout) as ({
      name?: unknown;
    } & MarketplaceSource)[];
    return entries.find((entry) => entry.name === MARKETPLACE_NAME);
  } catch {
    return null;
  }
};

// Copilot's marketplace list doesn't show the ref; its settings file does.
const copilotMarketplace = (): Registered => {
  const home = process.env.COPILOT_HOME || path.join(homedir(), ".copilot");
  let text: string;
  try {
    text = readFileSync(path.join(home, "settings.json"), "utf-8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? undefined
      : null;
  }
  try {
    const settings = JSON.parse(text) as {
      extraKnownMarketplaces?: Record<string, { source?: MarketplaceSource }>;
    };
    return settings.extraKnownMarketplaces?.[MARKETPLACE_NAME]?.source;
  } catch {
    // e.g. comments, which Copilot accepts
    return null;
  }
};

// Registers the marketplace on the release branch. A marketplace that is already
// registered is left as it is: moving it to another ref takes remove + add, which
// uninstalls the plugin and, in Claude Code, deletes its saved settings and key.
const addMarketplace = (
  client: "claude" | "copilot",
  name: string,
  registered: Registered
): string | null => {
  if (registered === null && client === "claude") {
    // add could re-point a foreign marketplace of that name and keep its plugin
    return `${name}: could not read "claude plugin marketplace list --json"; update Claude Code and run this setup again`;
  }
  if (registered === undefined || registered === null) {
    const added = run(client, ["plugin", "marketplace", "add", PINNED_SOURCE]);
    // Copilot fails when it is registered already, e.g. where its settings didn't say so;
    // any other failure may be a foreign source of that name, so it stops the setup
    if (!added.ok && ALREADY_REGISTERED_RE.test(added.output)) {
      log(`${name}: the marketplace is registered already; continuing with it`);
      return null;
    }
    const error = step(
      added,
      registered === undefined
        ? `${name}: marketplace added (${MARKETPLACE_REF} branch)`
        : `${name}: marketplace registered (could not check which branch it follows)`
    );
    // Claude refuses a source other than the one its settings declare for that name
    return error && client === "claude" && EXTRA_KNOWN_RE.test(added.output)
      ? `${error}\n${name}: edit or delete the ${MARKETPLACE_NAME} entry of extraKnownMarketplaces in your Claude Code user settings (settings.json in ~/.claude or $CLAUDE_CONFIG_DIR), then run this setup again; an entry in managed settings needs whoever manages them`
      : error;
  }
  if (typeof registered.repo !== "string") {
    // a git URL or a directory: its plugin would get the agent key, so don't guess
    return `${name}: the ${MARKETPLACE_NAME} marketplace is registered from a source other than ${MARKETPLACE_REPO}; remove it first`;
  }
  // GitHub names are case-insensitive
  if (registered.repo.toLowerCase() !== MARKETPLACE_REPO) {
    return `${name}: a different marketplace named ${MARKETPLACE_NAME} is registered (${registered.repo}); remove it first`;
  }
  if (registered.ref === MARKETPLACE_REF) {
    log(`${name}: marketplace already follows the ${MARKETPLACE_REF} branch`);
    return null;
  }
  log(
    `${name}: the marketplace follows ${typeof registered.ref === "string" ? registered.ref : "the default branch"}, not ${MARKETPLACE_REF}, so it can get unreleased changes. To follow releases, remove it (${removeCommand(client)}; this also removes the plugin and its settings) and run this setup again`
  );
  return null;
};

export const installClaude = (): string | null =>
  addMarketplace("claude", "Claude Code", claudeMarketplace()) ??
  step(
    run("claude", ["plugin", "install", PLUGIN_ID]),
    "Claude Code: plugin installed"
  );

export const installCopilot = (): string | null =>
  addMarketplace("copilot", "Copilot CLI", copilotMarketplace()) ??
  step(
    run("copilot", ["plugin", "install", PLUGIN_ID]),
    "Copilot CLI: plugin installed"
  );
