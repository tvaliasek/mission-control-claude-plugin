import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

export const ADMIN_KEY = "admin-test-key";
export const ISSUED_KEY = "mca_agentkey";
export const EXISTING_AGENT_KEY = "mca_existing";
// the agent EXISTING_AGENT_KEY belongs to
export const KEY_OWNER = "build-box";
const AGENT_ROUTE_RE = /^\/api\/agents\/(?<name>[^/]+)$/u;
const AGENT_KEYS_ROUTE_RE = /^\/api\/agents\/[^/]+\/keys$/u;

export const builtScript = (...parts: string[]) =>
  path.join(import.meta.dirname, "..", ...parts);

export interface RecordedRequest {
  method: string;
  url: string;
  key: string | undefined;
  body: Record<string, unknown>;
}

export interface MockServer {
  url: string;
  requests: RecordedRequest[];
  close: () => void;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => boolean;

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.end(JSON.stringify(body));
};

// Write endpoints, which only the admin key may use.
const respondAdmin = (
  route: string,
  res: ServerResponse,
  body: Record<string, unknown>,
  existingAgents: string[]
) => {
  if (route === "POST /api/agents/register") {
    const exists = existingAgents.includes(String(body.name));
    send(res, exists ? 200 : 201, {
      agent: { id: 7, name: body.name },
      registered: !exists,
    });
  } else if (route === "POST /api/agents/7/keys") {
    send(res, 201, {
      api_key: ISSUED_KEY,
      key: { id: 3, key_prefix: "mca_abcdef12" },
    });
  } else {
    send(res, 404, {});
  }
};

// Answers one request the way Mission Control v2.3.0 would for these endpoints.
// The admin key may do everything; EXISTING_AGENT_KEY may only read agents and,
// like Mission Control, is rejected when x-agent-name names another agent.
const respond = (
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  existingAgents: string[]
) => {
  const key = req.headers["x-api-key"];
  const route = `${req.method} ${req.url}`;
  const agentHeader = req.headers["x-agent-name"];
  const knownKey = key === ADMIN_KEY || key === EXISTING_AGENT_KEY;
  const wrongAgent =
    key === EXISTING_AGENT_KEY && agentHeader && agentHeader !== KEY_OWNER;
  if (!knownKey || wrongAgent) {
    send(res, 401, { error: "Authentication required" });
    return;
  }
  if (req.method === "GET" && AGENT_KEYS_ROUTE_RE.test(req.url ?? "")) {
    send(res, key === ADMIN_KEY ? 200 : 403, { keys: [] });
    return;
  }
  const lookup = req.method === "GET" && AGENT_ROUTE_RE.exec(req.url ?? "");
  if (lookup) {
    const name = decodeURIComponent(lookup.groups?.name ?? "");
    const exists = existingAgents.includes(name);
    send(res, exists ? 200 : 404, exists ? { agent: { id: 7, name } } : {});
    return;
  }
  if (key === ADMIN_KEY) {
    respondAdmin(route, res, body, existingAgents);
  } else {
    send(res, 403, { error: "Forbidden" });
  }
};

export const startMissionControl = async ({
  existingAgents = [] as string[],
  handler,
}: {
  existingAgents?: string[];
  handler?: Handler;
} = {}): Promise<MockServer> => {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      requests.push({
        body,
        key: req.headers["x-api-key"] as string | undefined,
        method: req.method ?? "",
        url: req.url ?? "",
      });
      res.setHeader("Content-Type", "application/json");
      if (!handler?.(req, res)) {
        respond(req, res, body, existingAgents);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    close: () => server.close(),
    requests,
    url: `http://127.0.0.1:${port}`,
  };
};

const tempDirs: string[] = [];

export const removeTempDirs = () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
};

export interface FakeCall {
  command: string;
  argv: string[];
  input: string;
  sawKeys: boolean;
}

export interface FakeBin {
  // directory to put on PATH
  dir: string;
  calls: () => FakeCall[];
}

// Fake `claude` / `copilot` executables that record every call. `exitCodes` maps a
// space-joined argv prefix to an exit code (default 0); `outputs` likewise to stderr.
export const fakeBins = (
  commands: string[],
  {
    exitCodes = {},
    outputs = {},
  }: {
    exitCodes?: Record<string, number>;
    outputs?: Record<string, string>;
  } = {}
): FakeBin => {
  const dir = mkdtempSync(path.join(tmpdir(), "mc-fake-bin-"));
  tempDirs.push(dir);
  const log = path.join(dir, "calls.jsonl");
  writeFileSync(log, "");
  for (const command of commands) {
    writeFileSync(
      path.join(dir, command),
      `#!${process.execPath}
const fs = require("fs");
const argv = process.argv.slice(2);
const joined = ${JSON.stringify(command)} + " " + argv.join(" ");
const pick = (map) => Object.keys(map).find((prefix) => joined.startsWith(prefix));
let input = "";
const done = () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
    command: ${JSON.stringify(command)}, argv, input,
    sawKeys: "MC_ADMIN_API_KEY" in process.env || "MC_API_KEY" in process.env,
  }) + "\\n");
  const outputs = ${JSON.stringify(outputs)};
  const out = pick(outputs);
  if (out) process.stderr.write(outputs[out]);
  const codes = ${JSON.stringify(exitCodes)};
  const code = pick(codes);
  process.exit(code ? codes[code] : 0);
};
if (process.stdin.isTTY) done();
else process.stdin.on("data", (d) => { input += d; }).on("end", done);
`,
      { mode: 0o755 }
    );
  }
  return {
    calls: () =>
      readFileSync(log, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeCall),
    dir,
  };
};

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export const runScript = async (
  script: string,
  args: string[],
  { env = {}, input }: { env?: Record<string, string>; input?: string } = {}
): Promise<RunResult> => {
  const child = spawn(process.execPath, [script, ...args], {
    env: { ...process.env, ...env },
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (input !== undefined) {
    child.stdin?.end(input);
  }
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code] = (await once(child, "close")) as [number | null];
  return { code, stderr, stdout };
};
