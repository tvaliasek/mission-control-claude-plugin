#!/usr/bin/env node
/*
 Interactive setup: installs the mission-control plugin into Claude Code and/or
 GitHub Copilot CLI and gives it an agent-scoped Mission Control API key.

 Usage: npx @tvaliasek/mission-control-claude-plugin

 Keys are read without echo, or from MC_API_KEY (an existing agent key) or
 MC_ADMIN_API_KEY (used once to issue an agent key, never stored). A key from the
 environment is used only when MC_URL names the same Mission Control URL.

 Source: src/setup.ts in github.com/tvaliasek/mission-control-claude-plugin
*/

import { hostname } from "node:os";

import {
  createPrompter,
  fail,
  failUnexpected,
  guardUnfinished,
  log,
  promptHidden,
  setProgram,
} from "./lib/cli.ts";
import type { Prompter } from "./lib/cli.ts";
import {
  PLUGIN_ID,
  configureClaude,
  installClaude,
  installCopilot,
  isInstalled,
} from "./lib/clients.ts";
import {
  AGENT_NAME_RULES,
  checkKey,
  enrollAgent,
  isRemotePlainHttp,
  isValidAgentName,
  normalizeUrl,
  verifyKey,
} from "./lib/mission-control.ts";

const KEY_EXPIRES_DAYS = 90;
const INVALID_NAME_CHARS_RE = /[^a-z0-9._-]+/gu;
const LEADING_NON_ALNUM_RE = /^[^a-z0-9]+/u;
const MAX_NAME_LENGTH = 63;

const defaultAgentName = () => {
  const name = hostname()
    .toLowerCase()
    .replaceAll(INVALID_NAME_CHARS_RE, "-")
    .replace(LEADING_NON_ALNUM_RE, "")
    .slice(0, MAX_NAME_LENGTH);
  return isValidAgentName(name) ? name : undefined;
};

// Single-quoted for POSIX shells; a ' inside the value becomes '\''.
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const TRAILING_SLASHES_RE = /\/+$/u;

const sameUrl = (a: string, b: string) => {
  try {
    const href = (value: string) =>
      new URL(value).href.replace(TRAILING_SLASHES_RE, "");
    return href(a) === href(b);
  } catch {
    return false;
  }
};

// A key from the environment goes only to the URL exported with it (MC_URL), so a
// key for one instance is never sent to another one typed here.
const envKey = (name: "MC_API_KEY" | "MC_ADMIN_API_KEY", url: string) => {
  const key = process.env[name]?.trim();
  if (!key) {
    return;
  }
  if (!sameUrl(process.env.MC_URL?.trim() ?? "", url)) {
    log(`ignoring ${name} from the environment: MC_URL is not ${url}`);
    return;
  }
  log(`using ${name} from the environment`);
  return key;
};

interface Clients {
  claude: boolean;
  copilot: boolean;
}

const chooseClients = async (prompt: Prompter): Promise<Clients> => {
  const hasClaude = isInstalled("claude");
  const hasCopilot = isInstalled("copilot");
  if (!(hasClaude || hasCopilot)) {
    fail("neither claude nor copilot was found on PATH");
  }
  const clients = {
    claude: hasClaude && (await prompt.confirm("Set up Claude Code?", true)),
    copilot:
      hasCopilot && (await prompt.confirm("Set up GitHub Copilot CLI?", true)),
  };
  if (!(clients.claude || clients.copilot)) {
    fail("nothing to set up");
  }
  return clients;
};

const obtainKey = async (
  prompt: Prompter,
  url: string,
  agent: string,
  clients: Clients
): Promise<string> => {
  const issueNew = await prompt.confirm(
    "Issue a new agent key now with the Mission Control admin key? (No: paste an existing agent key)",
    true
  );
  if (!issueNew) {
    const agentKey = checkKey(
      envKey("MC_API_KEY", url) ??
        (await promptHidden("Agent API key: ", "MC_API_KEY and MC_URL")),
      "agent API key"
    );
    await verifyKey(url, agentKey, agent);
    return agentKey;
  }
  const adminKey = checkKey(
    envKey("MC_ADMIN_API_KEY", url) ??
      (await promptHidden(
        "Mission Control admin API key (used once, not stored): ",
        "MC_ADMIN_API_KEY and MC_URL"
      )),
    "admin API key"
  );
  return enrollAgent({
    adminKey,
    agent,
    allowExisting: () =>
      prompt.confirm(
        `Agent "${agent}" already exists. Issue another key for it?`,
        false
      ),
    existingHint: "",
    expiresDays: KEY_EXPIRES_DAYS,
    framework: clients.claude ? "claude-code" : "copilot-cli",
    keyName: hostname(),
    url,
  });
};

const printCopilotEnv = (url: string, agentKey: string, agent: string) => {
  log(
    "Copilot CLI reads these from the environment. Put them where you keep secrets (not a shared dotfile) and start copilot from a shell that has them:"
  );
  process.stdout.write(
    [
      `export MC_URL=${shellQuote(url)}`,
      `export MC_API_KEY=${shellQuote(agentKey)}`,
      `export MC_AGENT_NAME=${shellQuote(agent)}`,
      "",
    ].join("\n")
  );
};

const main = async () => {
  setProgram("mission-control-claude-plugin");
  const prompt = await createPrompter();
  process.stderr.write(
    "Connects Claude Code or GitHub Copilot CLI to a Mission Control instance.\n\n"
  );
  const clients = await chooseClients(prompt);
  const url = normalizeUrl(
    await prompt.ask(
      "Mission Control URL (e.g. https://mc.example.com)",
      process.env.MC_URL?.trim()
    )
  );
  if (
    isRemotePlainHttp(url) &&
    !(await prompt.confirm(
      "This URL uses plain HTTP: API keys would cross the network unencrypted. Continue anyway?",
      false
    ))
  ) {
    fail("use an HTTPS URL");
  }
  const agent = await prompt.ask(
    "Agent name, unique per machine",
    defaultAgentName()
  );
  if (!isValidAgentName(agent)) {
    fail(`agent name must be ${AGENT_NAME_RULES}`);
  }

  // install first: nothing secret is involved yet, and a failure here issues no key
  const installError =
    (clients.claude ? installClaude() : null) ??
    (clients.copilot ? installCopilot() : null);
  if (installError) {
    fail(installError);
  }

  const agentKey = await obtainKey(prompt, url, agent, clients);

  if (clients.claude) {
    const error = configureClaude({
      agent_name: agent,
      mc_api_key: agentKey,
      mc_url: url,
    });
    if (error) {
      // a newly issued key exists server-side now; print it so it is not lost
      log(
        `${error}\nconfigure ${PLUGIN_ID} in Claude Code manually with this key:`
      );
      process.stdout.write(`${agentKey}\n`);
      process.exitCode = 1;
    } else {
      log("Claude Code: start a new session to use Mission Control");
    }
  }
  if (clients.copilot) {
    printCopilotEnv(url, agentKey, agent);
  }
};

const finished = guardUnfinished();
main().then(finished).catch(failUnexpected);
