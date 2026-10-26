import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, test } from "@rstest/core";

// Runs the built bundle, i.e. the file users download, so `npm run build` must run first.
const SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "plugins",
  "mission-control",
  "scripts",
  "mc-enroll.cjs"
);
const ADMIN_KEY = "admin-test-key";
const AGENT_ROUTE_RE = /^\/api\/agents\/(?<name>[^/]+)$/u;

interface RecordedRequest {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

interface MockServer {
  url: string;
  requests: RecordedRequest[];
  close: () => void;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => boolean;

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.end(JSON.stringify(body));
};

// Mock of the Mission Control v2.3.0 endpoints the script calls.
const startServer = async ({
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
      requests.push({ body, method: req.method ?? "", url: req.url ?? "" });
      res.setHeader("Content-Type", "application/json");
      if (handler?.(req, res)) {
        return;
      }
      if (req.headers["x-api-key"] !== ADMIN_KEY) {
        send(res, 401, { error: "Authentication required" });
        return;
      }
      const lookup = req.method === "GET" && AGENT_ROUTE_RE.exec(req.url ?? "");
      if (lookup) {
        const name = decodeURIComponent(lookup.groups?.name ?? "");
        if (existingAgents.includes(name)) {
          send(res, 200, { agent: { id: 7, name } });
        } else {
          send(res, 404, { error: "Agent not found" });
        }
        return;
      }
      if (req.method === "POST" && req.url === "/api/agents/register") {
        const exists = existingAgents.includes(String(body.name));
        send(res, exists ? 200 : 201, {
          agent: { id: 7, name: body.name },
          registered: !exists,
        });
        return;
      }
      if (req.method === "POST" && req.url === "/api/agents/7/keys") {
        send(res, 201, {
          api_key: "mca_agentkey",
          key: { id: 3, key_prefix: "mca_abcdef12" },
        });
        return;
      }
      send(res, 404, {});
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

const run = async (
  args: string[],
  env: Record<string, string> = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> => {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, MC_ADMIN_API_KEY: ADMIN_KEY, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code] = (await once(child, "close")) as [number | null];
  return { code, stderr, stdout };
};

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

// A fake `claude` on PATH that records its argv, stdin and whether it saw the admin key.
const fakeClaude = (exitCode: number) => {
  const dir = mkdtempSync(path.join(tmpdir(), "mc-enroll-claude-"));
  tempDirs.push(dir);
  const out = path.join(dir, "out.json");
  writeFileSync(
    path.join(dir, "claude"),
    `#!${process.execPath}
let input = "";
process.stdin.on("data", (d) => { input += d; }).on("end", () => {
  require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({
    argv: process.argv.slice(2), input, sawAdminKey: "MC_ADMIN_API_KEY" in process.env,
  }));
  process.exit(${exitCode});
});
`,
    { mode: 0o755 }
  );
  return {
    PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
    read: () =>
      JSON.parse(readFileSync(out, "utf-8")) as {
        argv: string[];
        input: string;
        sawAdminKey: boolean;
      },
  };
};

describe("mc-enroll", () => {
  test("--print registers the agent and prints only the agent key", async () => {
    const srv = await startServer();
    try {
      const r = await run([
        "--url",
        srv.url,
        "--agent",
        "build-box",
        "--key-name",
        "ci",
        "--print",
      ]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toBe("mca_agentkey\n");
      expect(r.stderr).not.toContain(ADMIN_KEY);
      expect(srv.requests.map((q) => `${q.method} ${q.url}`)).toEqual([
        "GET /api/agents/build-box",
        "POST /api/agents/register",
        "POST /api/agents/7/keys",
      ]);
      expect(srv.requests[2]?.body).toEqual({
        expires_in_days: 90,
        name: "ci",
        scopes: ["operator"],
      });
    } finally {
      srv.close();
    }
  });

  test("refuses an existing agent without touching it unless --existing is given", async () => {
    const srv = await startServer({ existingAgents: ["build-box"] });
    try {
      const refused = await run([
        "--url",
        srv.url,
        "--agent",
        "build-box",
        "--print",
      ]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(/already exists/u);
      // only the read-only lookup may run
      expect(srv.requests.map((q) => q.method)).toEqual(["GET"]);

      const allowed = await run([
        "--url",
        srv.url,
        "--agent",
        "build-box",
        "--existing",
        "--print",
      ]);
      expect(allowed.code, allowed.stderr).toBe(0);
      expect(allowed.stdout).toBe("mca_agentkey\n");
    } finally {
      srv.close();
    }
  });

  test("reports an HTTP error without issuing a key", async () => {
    const srv = await startServer();
    try {
      const r = await run(
        ["--url", srv.url, "--agent", "build-box", "--print"],
        { MC_ADMIN_API_KEY: "wrong" }
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/HTTP 401/u);
      expect(r.stdout).toBe("");
    } finally {
      srv.close();
    }
  });

  test("does not follow redirects with the admin key", async () => {
    const other = await startServer();
    const srv = await startServer({
      handler: (req, res) => {
        res.statusCode = 307;
        res.setHeader("Location", `${other.url}${req.url ?? ""}`);
        res.end();
        return true;
      },
    });
    try {
      const r = await run([
        "--url",
        srv.url,
        "--agent",
        "build-box",
        "--print",
      ]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/redirects are not followed/u);
      expect(other.requests).toHaveLength(0);
    } finally {
      srv.close();
      other.close();
    }
  });

  test("rejects a key with control characters without echoing it", async () => {
    const srv = await startServer();
    try {
      const r = await run(
        ["--url", srv.url, "--agent", "build-box", "--print"],
        { MC_ADMIN_API_KEY: "ab\u0004secret" }
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/invalid characters/u);
      expect(r.stderr).not.toContain("secret");
      expect(srv.requests).toHaveLength(0);
    } finally {
      srv.close();
    }
  });

  test("configures the plugin through claude without passing on the admin key", async () => {
    const srv = await startServer();
    const claude = fakeClaude(0);
    try {
      const r = await run(["--url", srv.url, "--agent", "build-box"], {
        PATH: claude.PATH,
      });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toBe("");
      const seen = claude.read();
      expect(seen.argv).toEqual([
        "plugin",
        "configure",
        "mission-control@mission-control",
        "--values-stdin",
      ]);
      expect(JSON.parse(seen.input)).toEqual({
        agent_name: "build-box",
        mc_api_key: "mca_agentkey",
        mc_url: srv.url,
      });
      expect(seen.sawAdminKey).toBe(false);
    } finally {
      srv.close();
    }
  });

  test("prints the issued key when configuring the plugin fails", async () => {
    const srv = await startServer();
    const claude = fakeClaude(3);
    try {
      const r = await run(["--url", srv.url, "--agent", "build-box"], {
        PATH: claude.PATH,
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/exited with 3/u);
      expect(r.stdout).toBe("mca_agentkey\n");
    } finally {
      srv.close();
    }
  });

  test.each([
    [["--agent", "x"], /--url is required/u],
    [["--url", "ftp://mc.example.com", "--agent", "x"], /HTTP or HTTPS/u],
    [["--url", "https://u:p@mc.example.com", "--agent", "x"], /credentials/u],
    [
      ["--url", "https://mc.example.com", "--agent", "-bad"],
      /--agent is required/u,
    ],
    [
      ["--url", "https://mc.example.com", "--agent", "123"],
      /--agent is required/u,
    ],
    [
      [
        "--url",
        "https://mc.example.com",
        "--agent",
        "x",
        "--expires-days",
        "0",
      ],
      /--expires-days/u,
    ],
  ])(
    "rejects invalid arguments %j before any request",
    async (args, message) => {
      const r = await run(args);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(message);
    }
  );
});
