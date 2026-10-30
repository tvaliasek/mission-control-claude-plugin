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
   --revoke-old         Revoke the agent's other active keys once the new key is saved
                        (not with --print)
   --print              Print the agent key instead of configuring the local plugin
   --allow-http         Allow a plain-HTTP URL to another machine (keys unencrypted)

 The admin key is read from MC_ADMIN_API_KEY (only when MC_URL names the same URL
 as --url) or prompted for without echo.
 It is never written anywhere. Without --print, the agent key is saved with
 `claude plugin configure mission-control@mission-control --values-stdin`.

 Source: src/mc-enroll.ts in github.com/tvaliasek/mission-control-claude-plugin
*/

import { hostname } from "node:os";

import {
  fail,
  failUnexpected,
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
  envKey,
  isRemotePlainHttp,
  isValidAgentName,
  normalizeUrl,
  revokeOtherKeys,
} from "./lib/mission-control.ts";

const MAX_EXPIRES_DAYS = 3650;
const DEFAULT_EXPIRES_DAYS = 90;

interface Options {
  url: string;
  agent: string;
  keyName: string;
  expiresDays: number;
  existing: boolean;
  revokeOld: boolean;
  print: boolean;
  allowHttp: boolean;
}

const parseArgs = (argv: string[]): Options => {
  let url: string | undefined;
  let agent: string | undefined;
  const opts = {
    allowHttp: false,
    existing: false,
    expiresDays: DEFAULT_EXPIRES_DAYS,
    keyName: hostname(),
    print: false,
    revokeOld: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      // e.g. "--key-name --print" would otherwise swallow --print
      if (next === undefined || next.startsWith("--")) {
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
      case "--revoke-old": {
        opts.revokeOld = true;
        break;
      }
      case "--print": {
        opts.print = true;
        break;
      }
      case "--allow-http": {
        opts.allowHttp = true;
        break;
      }
      case "-h":
      case "--help": {
        process.stdout.write(
          "Usage: node mc-enroll.cjs --url URL --agent NAME [--key-name NAME] [--expires-days N] [--existing] [--revoke-old] [--print] [--allow-http]\n"
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
  const normalized = normalizeUrl(url);
  if (isRemotePlainHttp(normalized) && !opts.allowHttp) {
    fail(
      "plain HTTP would send API keys unencrypted; use HTTPS or pass --allow-http"
    );
  }
  return { ...opts, agent, url: normalized };
};

const main = async () => {
  setProgram("mc-enroll");
  const opts = parseArgs(process.argv.slice(2));
  if (opts.print && opts.revokeOld) {
    // a printed key is not in use yet; revoking now would cut the agent off until it is
    fail(
      "--revoke-old can't be used with --print: revoke on the agent machine, where the new key is saved first"
    );
  }
  const adminKey = checkKey(
    envKey("MC_ADMIN_API_KEY", opts.url) ??
      (await promptHidden(
        "Mission Control admin API key: ",
        "MC_ADMIN_API_KEY and MC_URL"
      )),
    "admin API key"
  );

  const issued = await enrollAgent({
    adminKey,
    agent: opts.agent,
    allowExisting: () => Promise.resolve(opts.existing),
    existingHint: "; pass --existing to issue it another key",
    expiresDays: opts.expiresDays,
    framework: "claude-code",
    keyName: opts.keyName,
    url: opts.url,
  });

  const agentKey = issued.apiKey;
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
  if (isRemotePlainHttp(opts.url)) {
    log(
      `the plugin refuses plain HTTP unless MC_ALLOW_HTTP=${new URL(opts.url).host} is set in the environment claude starts from`
    );
  }
  // only now that the new key is saved; exit 2 (not 1, which means the key is on
  // stdout) tells a script that old keys may be active
  if (
    opts.revokeOld &&
    !(await revokeOtherKeys(opts.url, adminKey, issued, () =>
      Promise.resolve(true)
    ))
  ) {
    process.exitCode = 2;
  }
};

const finished = guardUnfinished();
main().then(finished).catch(failUnexpected);
