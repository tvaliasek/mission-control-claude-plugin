#!/usr/bin/env node
/*
 Enroll a Claude Code agent with Mission Control using an admin API key once,
 then hand the agent only an agent-scoped key.

 Usage:
   node mc-enroll.cjs --url https://mc.example.com --agent build-box [--print]

 Options:
   --url URL            Mission Control base URL (required)
   --agent NAME         Agent name to register (required)
   --key-name NAME      Label for the issued key (default: this hostname)
   --expires-days N     Key lifetime in days, 1-3650 (default: 90)
   --existing           Allow issuing a key for an agent that already exists
   --print              Print the agent key instead of configuring the local plugin

 The admin key is read from MC_ADMIN_API_KEY or prompted for without echo.
 It is never written anywhere. Without --print, the agent key is saved with
 `claude plugin configure mission-control@mission-control --values-stdin`.

 Source: src/mc-enroll.ts in github.com/tvaliasek/mission-control-claude-plugin
*/

import { hostname } from "node:os";

import {
  fail,
  guardUnfinished,
  log,
  promptHidden,
  setProgram,
} from "./lib/cli.ts";
import { PLUGIN_ID, configureClaude } from "./lib/clients.ts";
import {
  AGENT_NAME_RULES,
  checkKey,
  enrollAgent,
  isValidAgentName,
  normalizeUrl,
} from "./lib/mission-control.ts";

const MAX_EXPIRES_DAYS = 3650;
const DEFAULT_EXPIRES_DAYS = 90;

interface Options {
  url: string;
  agent: string;
  keyName: string;
  expiresDays: number;
  existing: boolean;
  print: boolean;
}

const parseArgs = (argv: string[]): Options => {
  let url: string | undefined;
  let agent: string | undefined;
  const opts = {
    existing: false,
    expiresDays: DEFAULT_EXPIRES_DAYS,
    keyName: hostname(),
    print: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) {
        return fail(`${arg} needs a value`);
      }
      i += 1;
      return next;
    };
    switch (arg) {
      case "--url": {
        url = value();
        break;
      }
      case "--agent": {
        agent = value();
        break;
      }
      case "--key-name": {
        opts.keyName = value();
        break;
      }
      case "--expires-days": {
        opts.expiresDays = Number(value());
        break;
      }
      case "--existing": {
        opts.existing = true;
        break;
      }
      case "--print": {
        opts.print = true;
        break;
      }
      case "-h":
      case "--help": {
        process.stdout.write(
          "Usage: node mc-enroll.cjs --url URL --agent NAME [--key-name NAME] [--expires-days N] [--existing] [--print]\n"
        );
        process.exit(0);
        break;
      }
      default: {
        fail(`unknown argument: ${arg}`);
      }
    }
  }
  if (!url) {
    return fail("--url is required");
  }
  if (!(agent && isValidAgentName(agent))) {
    return fail(`--agent is required: ${AGENT_NAME_RULES}`);
  }
  if (
    !Number.isInteger(opts.expiresDays) ||
    opts.expiresDays < 1 ||
    opts.expiresDays > MAX_EXPIRES_DAYS
  ) {
    fail(`--expires-days must be an integer between 1 and ${MAX_EXPIRES_DAYS}`);
  }
  return { ...opts, agent, url: normalizeUrl(url) };
};

const main = async () => {
  setProgram("mc-enroll");
  const opts = parseArgs(process.argv.slice(2));
  const adminKey = checkKey(
    process.env.MC_ADMIN_API_KEY?.trim() ||
      (await promptHidden(
        "Mission Control admin API key: ",
        "MC_ADMIN_API_KEY"
      )),
    "admin API key"
  );

  const agentKey = await enrollAgent({
    adminKey,
    agent: opts.agent,
    allowExisting: () => Promise.resolve(opts.existing),
    expiresDays: opts.expiresDays,
    framework: "claude-code",
    keyName: opts.keyName,
    url: opts.url,
  });

  if (opts.print) {
    process.stdout.write(`${agentKey}\n`);
    return;
  }

  const error = configureClaude({
    agent_name: opts.agent,
    mc_api_key: agentKey,
    mc_url: opts.url,
  });
  if (error) {
    // The key exists server-side now; print it so it is not lost.
    log(`${error}\nmc-enroll: configure the plugin manually with this key:`);
    process.stdout.write(`${agentKey}\n`);
    process.exitCode = 1;
    return;
  }
  log(`start a new Claude Code session to use ${PLUGIN_ID}`);
};

const finished = guardUnfinished();
main()
  .then(finished)
  .catch(() => fail("unexpected error"));
