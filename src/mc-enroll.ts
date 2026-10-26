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

import { spawnSync } from "node:child_process";
import { hostname } from "node:os";

const PLUGIN_ID = "mission-control@mission-control";
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/u;
const DIGITS_RE = /^\d+$/u;
// Printable ASCII only: anything else is rejected by fetch with an error that echoes the value
const KEY_RE = /^[!-~]+$/u;
const TRAILING_SLASHES_RE = /\/+$/u;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_EXPIRES_DAYS = 3650;
const DEFAULT_EXPIRES_DAYS = 90;
const REQUEST_TIMEOUT_MS = 30_000;
const SIGINT_EXIT_CODE = 130;

interface Options {
  url: string;
  agent: string;
  keyName: string;
  expiresDays: number;
  existing: boolean;
  print: boolean;
}

interface ApiResult {
  status: number;
  ok: boolean;
  data: Record<string, unknown>;
}

interface RegisterResponse {
  agent?: { id?: number | string; name?: string };
  registered?: boolean;
}

interface KeyResponse {
  api_key?: string;
  key?: { id?: number; key_prefix?: string };
}

const fail = (message: string): never => {
  process.stderr.write(`mc-enroll: ${message}\n`);
  process.exit(1);
};

// Same rules as the bundled mc-base-url.cjs, inlined so this file can be downloaded on its own.
const normalizeUrl = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return fail("--url must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("--url must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    fail("--url must not contain credentials");
  }
  if (parsed.search || parsed.hash) {
    fail("--url must not contain a query string or fragment");
  }
  if (parsed.protocol === "http:" && !LOCAL_HOSTS.has(parsed.hostname)) {
    process.stderr.write(
      "mc-enroll: warning: plain HTTP sends the admin key unencrypted\n"
    );
  }
  return parsed.toString().replace(TRAILING_SLASHES_RE, "");
};

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
  // all-digit names are rejected because Mission Control resolves them as agent ids
  if (!(agent && NAME_RE.test(agent)) || DIGITS_RE.test(agent)) {
    return fail(
      "--agent is required: 1-63 letters, digits, dots, hyphens or underscores, starting with a letter or digit, not only digits"
    );
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

const readHidden = async (stdin: NodeJS.ReadStream): Promise<string> => {
  let input = "";
  // stdin ending (terminal closed) also ends the loop. Without destroyOnReturn: false,
  // returning early destroys stdin and Node 18 then can't leave raw mode.
  for await (const chunk of stdin.iterator({ destroyOnReturn: false })) {
    for (const ch of chunk as string) {
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        return input;
      }
      if (ch === "\u0003") {
        stdin.setRawMode(false);
        process.stderr.write("\n");
        process.exit(SIGINT_EXIT_CODE);
      }
      input = ch === "\u007F" || ch === "\b" ? input.slice(0, -1) : input + ch;
    }
  }
  return input;
};

const promptHidden = async (question: string): Promise<string> => {
  const { stdin } = process;
  if (!stdin.isTTY) {
    fail(
      "no terminal to prompt for the admin key; set MC_ADMIN_API_KEY instead"
    );
  }
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding("utf-8");
  try {
    return await readHidden(stdin);
  } finally {
    stdin.setRawMode(false);
    process.stderr.write("\n");
  }
};

const api = async (
  baseUrl: string,
  adminKey: string,
  method: string,
  route: string,
  body?: unknown
): Promise<ApiResult> => {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${route}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": adminKey,
      },
      method,
      // following a redirect would send the admin key to the redirect target
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // fetch error messages can contain header values, so report only the cause code
    const err = (error ?? {}) as { name?: string; cause?: { code?: string } };
    return fail(
      `${method} ${route} failed: ${err.cause?.code ?? err.name ?? "network error"} (redirects are not followed)`
    );
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // non-JSON body: keep the status only
  }
  return { data, ok: res.ok, status: res.status };
};

const checked = <T>(method: string, route: string, result: ApiResult): T => {
  if (!result.ok) {
    const detail =
      typeof result.data.error === "string" ? ` ${result.data.error}` : "";
    fail(`${method} ${route} failed: HTTP ${result.status}${detail}`);
  }
  return result.data as T;
};

const configurePlugin = (values: Record<string, string>): string | null => {
  const env = { ...process.env };
  delete env.MC_ADMIN_API_KEY;
  const result = spawnSync(
    "claude",
    ["plugin", "configure", PLUGIN_ID, "--values-stdin"],
    {
      env,
      input: JSON.stringify(values),
      stdio: ["pipe", "inherit", "inherit"],
    }
  );
  if (result.error) {
    const { code } = result.error as NodeJS.ErrnoException;
    return `could not run claude: ${code ?? result.error.message}`;
  }
  if (result.status !== 0) {
    return `claude plugin configure exited with ${result.status}`;
  }
  return null;
};

const main = async () => {
  const opts = parseArgs(process.argv.slice(2));
  const adminKey = (
    process.env.MC_ADMIN_API_KEY?.trim() ||
    (await promptHidden("Mission Control admin API key: "))
  ).trim();
  if (!adminKey) {
    fail("admin API key is empty");
  }
  if (!KEY_RE.test(adminKey)) {
    fail("admin API key contains invalid characters");
  }

  // look up first: registering an existing agent would reset its status to idle
  const agentRoute = `/api/agents/${encodeURIComponent(opts.agent)}`;
  const lookup = await api(opts.url, adminKey, "GET", agentRoute);
  if (lookup.status !== 404) {
    checked("GET", agentRoute, lookup);
    if (!opts.existing) {
      fail(
        `agent "${opts.agent}" already exists; pass --existing to issue it another key`
      );
    }
  }

  const registerRoute = "/api/agents/register";
  const reg = checked<RegisterResponse>(
    "POST",
    registerRoute,
    await api(opts.url, adminKey, "POST", registerRoute, {
      framework: "claude-code",
      name: opts.agent,
    })
  );
  const agentId = reg.agent?.id;
  if (agentId === undefined || agentId === null) {
    fail(`unexpected response from ${registerRoute}`);
  }
  process.stderr.write(
    `mc-enroll: agent "${reg.agent?.name}" ${reg.registered ? "registered" : "exists"} (id ${agentId})\n`
  );

  // operator is the lowest role that can connect, heartbeat, poll the queue and update tasks
  const keysRoute = `/api/agents/${agentId}/keys`;
  const issued = checked<KeyResponse>(
    "POST",
    keysRoute,
    await api(opts.url, adminKey, "POST", keysRoute, {
      expires_in_days: opts.expiresDays,
      name: opts.keyName,
      scopes: ["operator"],
    })
  );
  const agentKey = issued.api_key;
  if (!agentKey) {
    return fail("unexpected response from the key endpoint");
  }
  process.stderr.write(
    `mc-enroll: issued key ${issued.key?.key_prefix ?? ""}… (id ${issued.key?.id ?? "?"}), expires in ${opts.expiresDays} days\n`
  );

  if (opts.print) {
    process.stdout.write(`${agentKey}\n`);
    return;
  }

  const error = configurePlugin({
    agent_name: opts.agent,
    mc_api_key: agentKey,
    mc_url: opts.url,
  });
  if (error) {
    // The key exists server-side now; print it so it is not lost.
    process.stderr.write(
      `mc-enroll: ${error}\nmc-enroll: configure the plugin manually with this key:\n`
    );
    process.stdout.write(`${agentKey}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(
    `mc-enroll: configured ${PLUGIN_ID}; start a new Claude Code session to use it\n`
  );
};

main().catch(() => fail("unexpected error"));
