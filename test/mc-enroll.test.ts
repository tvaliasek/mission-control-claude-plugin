import { afterAll, describe, expect, test } from "@rstest/core";

import {
  ADMIN_KEY,
  ISSUED_KEY,
  builtScript,
  fakeBins,
  removeTempDirs,
  runScript,
  startMissionControl,
} from "./helpers.ts";

// Runs the built bundle, i.e. the file users download, so `npm run build` must run first.
const SCRIPT = builtScript(
  "plugins",
  "mission-control",
  "scripts",
  "mc-enroll.cjs"
);

afterAll(removeTempDirs);

const run = (args: string[], env: Record<string, string> = {}) =>
  runScript(SCRIPT, args, { env: { MC_ADMIN_API_KEY: ADMIN_KEY, ...env } });

describe("mc-enroll", () => {
  test("--print registers the agent and prints only the agent key", async () => {
    const srv = await startMissionControl();
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
      expect(r.stdout).toBe(`${ISSUED_KEY}\n`);
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
    const srv = await startMissionControl({ existingAgents: ["build-box"] });
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
      expect(allowed.stdout).toBe(`${ISSUED_KEY}\n`);
    } finally {
      srv.close();
    }
  });

  test("reports an HTTP error without issuing a key", async () => {
    const srv = await startMissionControl();
    try {
      const r = await run(
        ["--url", srv.url, "--agent", "build-box", "--print"],
        {
          MC_ADMIN_API_KEY: "wrong",
        }
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/HTTP 401/u);
      expect(r.stdout).toBe("");
    } finally {
      srv.close();
    }
  });

  test("does not follow redirects with the admin key", async () => {
    const other = await startMissionControl();
    const srv = await startMissionControl({
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
    const srv = await startMissionControl();
    try {
      const r = await run(
        ["--url", srv.url, "--agent", "build-box", "--print"],
        {
          MC_ADMIN_API_KEY: "ab\u0004secret",
        }
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
    const srv = await startMissionControl();
    const bins = fakeBins(["claude"]);
    try {
      const r = await run(["--url", srv.url, "--agent", "build-box"], {
        PATH: bins.dir,
      });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toBe("");
      const [call] = bins.calls();
      expect(call?.argv).toEqual([
        "plugin",
        "configure",
        "mission-control@mission-control",
        "--values-stdin",
      ]);
      expect(JSON.parse(call?.input ?? "")).toEqual({
        agent_name: "build-box",
        mc_api_key: ISSUED_KEY,
        mc_url: srv.url,
      });
      expect(call?.sawKeys).toBe(false);
    } finally {
      srv.close();
    }
  });

  test("prints the issued key when configuring the plugin fails", async () => {
    const srv = await startMissionControl();
    const bins = fakeBins(["claude"], {
      exitCodes: { "claude plugin configure": 3 },
    });
    try {
      const r = await run(["--url", srv.url, "--agent", "build-box"], {
        PATH: bins.dir,
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/exited with 3/u);
      expect(r.stdout).toBe(`${ISSUED_KEY}\n`);
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
