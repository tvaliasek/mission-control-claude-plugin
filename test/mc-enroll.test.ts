import type { IncomingMessage, ServerResponse } from "node:http";

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

// MC_URL names the --url instance, which an admin key from the environment requires.
const run = (args: string[], env: Record<string, string> = {}) =>
  runScript(SCRIPT, args, {
    env: {
      MC_ADMIN_API_KEY: ADMIN_KEY,
      MC_URL: args[args.indexOf("--url") + 1] ?? "",
      ...env,
    },
  });

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
      expect(refused.stderr).toMatch(/already exists.*pass --existing/u);
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
      // registering again would reset the working agent's status
      expect(srv.requests.slice(1).map((q) => `${q.method} ${q.url}`)).toEqual([
        "GET /api/agents/build-box",
        "POST /api/agents/7/keys",
      ]);
    } finally {
      srv.close();
    }
  });

  test("--revoke-old revokes the agent's other active keys once the new one is saved", async () => {
    const now = Math.floor(Date.now() / 1000);
    const srv = await startMissionControl({
      agentKeys: [
        {
          expires_at: null,
          id: 1,
          key_prefix: "mca_old11111",
          last_used_at: null,
          name: "old",
          revoked_at: null,
        },
        {
          expires_at: now - 60,
          id: 2,
          key_prefix: "mca_exp22222",
          last_used_at: null,
          name: "expired",
          revoked_at: null,
        },
        {
          expires_at: null,
          id: 3,
          key_prefix: "mca_abcdef12",
          last_used_at: null,
          name: "new",
          revoked_at: null,
        },
      ],
      existingAgents: ["build-box"],
    });
    const bins = fakeBins(["claude"]);
    try {
      const r = await run(
        [
          "--url",
          srv.url,
          "--agent",
          "build-box",
          "--existing",
          "--revoke-old",
        ],
        { PATH: bins.dir }
      );
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toBe("");
      expect(
        srv.requests
          .filter((q) => q.method === "DELETE")
          .map((q) => q.body.key_id)
      ).toEqual([1]);
      expect(r.stderr).toMatch(/revoked key id 1/u);
    } finally {
      srv.close();
    }
  });

  test.each([
    [
      500,
      '{"error":"db"}',
      /could not list earlier keys, none revoked: HTTP 500 db/u,
    ],
    [500, "null", /could not list earlier keys, none revoked: HTTP 500$/mu],
    [200, "[]", /unexpected answer listing earlier keys, none revoked/u],
    [
      200,
      '{"keys":[{"id":"1","revoked_at":null}]}',
      /unexpected answer listing earlier keys, none revoked/u,
    ],
  ])(
    "--revoke-old exits 2 but keeps the saved key when listing answers %s %s",
    async (status, body, message) => {
      const srv = await startMissionControl({
        existingAgents: ["build-box"],
        handler: (req, res) => {
          if (req.method !== "GET" || !req.url?.endsWith("/keys")) {
            return false;
          }
          res.statusCode = status;
          res.end(body);
          return true;
        },
      });
      const bins = fakeBins(["claude"]);
      try {
        const r = await run(
          [
            "--url",
            srv.url,
            "--agent",
            "build-box",
            "--existing",
            "--revoke-old",
          ],
          { PATH: bins.dir }
        );
        expect(r.code).toBe(2);
        expect(r.stderr).toMatch(message);
        expect(bins.calls()[0]?.argv).toContain("configure");
        expect(srv.requests.some((q) => q.method === "DELETE")).toBe(false);
      } finally {
        srv.close();
      }
    }
  );

  test("--revoke-old does not look for earlier keys of a newly registered agent", async () => {
    const srv = await startMissionControl();
    const bins = fakeBins(["claude"]);
    try {
      const r = await run(
        ["--url", srv.url, "--agent", "build-box", "--revoke-old"],
        { PATH: bins.dir }
      );
      expect(r.code, r.stderr).toBe(0);
      expect(
        srv.requests.filter(
          (q) => q.method === "GET" && q.url.endsWith("/keys")
        )
      ).toEqual([]);
    } finally {
      srv.close();
    }
  });

  test("treats a registration the server does not confirm as new as existing", async () => {
    const srv = await startMissionControl({
      handler: (req, res) => {
        if (req.url !== "/api/agents/register") {
          return false;
        }
        res.statusCode = 201;
        res.end(JSON.stringify({ agent: { id: 7, name: "build-box" } }));
        return true;
      },
    });
    try {
      const r = await run([
        "--url",
        srv.url,
        "--agent",
        "build-box",
        "--revoke-old",
      ]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/agent "build-box" already exists/u);
      expect(srv.requests.some((q) => q.url === "/api/agents/7/keys")).toBe(
        false
      );
    } finally {
      srv.close();
    }
  });

  test("treats an agent registered by someone else after the lookup as existing", async () => {
    const srv = await startMissionControl({
      existingAgents: ["build-box"],
      // the lookup misses it; register then answers with the existing agent
      handler: (req, res) => {
        if (req.method !== "GET" || req.url !== "/api/agents/build-box") {
          return false;
        }
        res.statusCode = 404;
        res.end("{}");
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
      expect(r.stderr).toMatch(/agent "build-box" already exists/u);
      expect(srv.requests.some((q) => q.url === "/api/agents/7/keys")).toBe(
        false
      );
    } finally {
      srv.close();
    }
  });

  test.each([
    [
      "an agent registered by someone else after the lookup",
      ["build-box"],
      // the lookup misses it; register then answers with the existing agent
      (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "GET" || req.url !== "/api/agents/build-box") {
          return false;
        }
        res.statusCode = 404;
        res.end("{}");
        return true;
      },
    ],
    [
      "a registration the server does not confirm as new",
      [],
      (req: IncomingMessage, res: ServerResponse) => {
        if (req.url !== "/api/agents/register") {
          return false;
        }
        res.statusCode = 201;
        res.end(JSON.stringify({ agent: { id: 7, name: "build-box" } }));
        return true;
      },
    ],
  ])(
    "--revoke-old revokes earlier keys of %s",
    async (_case, existingAgents, handler) => {
      const srv = await startMissionControl({
        agentKeys: [
          {
            expires_at: null,
            id: 1,
            key_prefix: "mca_old11111",
            // out of Date's range: must not stop the revocation
            last_used_at: 1e13,
            name: "old",
            revoked_at: null,
          },
        ],
        existingAgents,
        handler,
      });
      const bins = fakeBins(["claude"]);
      try {
        const r = await run(
          [
            "--url",
            srv.url,
            "--agent",
            "build-box",
            "--existing",
            "--revoke-old",
          ],
          { PATH: bins.dir }
        );
        expect(r.code, r.stderr).toBe(0);
        expect(
          srv.requests
            .filter((q) => q.method === "DELETE")
            .map((q) => q.body.key_id)
        ).toEqual([1]);
      } finally {
        srv.close();
      }
    }
  );

  test("refuses --revoke-old with --print before contacting the server", async () => {
    const srv = await startMissionControl();
    try {
      const r = await run([
        "--url",
        srv.url,
        "--agent",
        "build-box",
        "--revoke-old",
        "--print",
      ]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/--revoke-old can't be used with --print/u);
      expect(srv.requests).toEqual([]);
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
      expect(r.stderr).toMatch(/answered with a redirect/u);
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

  test("ignores an admin key from the environment exported for another URL", async () => {
    const srv = await startMissionControl();
    try {
      const r = await run(
        ["--url", srv.url, "--agent", "build-box", "--print"],
        { MC_URL: "https://other.example.com" }
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/ignoring MC_ADMIN_API_KEY/u);
      expect(srv.requests).toHaveLength(0);
    } finally {
      srv.close();
    }
  });

  test.each([
    [
      "an issued key with a newline",
      "mca_bad\nkey",
      /issued key contains invalid characters/u,
    ],
    ["a numeric issued key", 12_345, /issued key is empty or not a string/u],
  ])(
    "refuses %s but logs its id for revocation",
    async (_case, apiKey, message) => {
      const srv = await startMissionControl({
        handler: (req, res) => {
          if (req.method !== "POST" || !req.url?.endsWith("/keys")) {
            return false;
          }
          res.statusCode = 201;
          res.end(JSON.stringify({ api_key: apiKey, key: { id: 3 } }));
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
        expect(r.stderr).toMatch(message);
        expect(r.stderr).toMatch(/\(id 3\)/u);
        expect(r.stdout).toBe("");
      } finally {
        srv.close();
      }
    }
  );

  test("neutralises control and bidi characters in server errors", async () => {
    const srv = await startMissionControl({
      handler: (_req, res) => {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: "a\u001B[31mb\u202Ec\u200Fd\u2028e" }));
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
      expect(r.stderr).toContain("a?[31mb?c?d?e");
    } finally {
      srv.close();
    }
  });

  test("refuses a registration answer for another agent", async () => {
    const srv = await startMissionControl({
      handler: (req, res) => {
        if (req.url !== "/api/agents/register") {
          return false;
        }
        res.statusCode = 201;
        res.end(
          JSON.stringify({ agent: { id: "7/../../settings", name: "other" } })
        );
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
      expect(r.stderr).toMatch(
        /unexpected response from \/api\/agents\/register/u
      );
      expect(srv.requests.map((q) => q.method)).toEqual(["GET", "POST"]);
    } finally {
      srv.close();
    }
  });

  test.each([
    [["--agent", "x"], /--url is required/u],
    [["--url", "http://mc.invalid", "--agent", "x"], /--allow-http/u],
    [
      ["--url", "https://mc.invalid", "--agent", "x", "--key-name", "--print"],
      /--key-name needs a value/u,
    ],
    [["--url", "ftp://mc.invalid", "--agent", "x"], /HTTP or HTTPS/u],
    [["--url", "https://u:p@mc.invalid", "--agent", "x"], /credentials/u],
    [
      ["--url", "https://mc.invalid", "--agent", "-bad"],
      /--agent is required/u,
    ],
    [["--url", "https://mc.invalid", "--agent", "123"], /--agent is required/u],
    [["--url", "https://mc.invalid", "--agent", "1e3"], /--agent is required/u],
    [
      ["--url", "https://mc.invalid", "--agent", "x", "--expires-days", "0"],
      /--expires-days/u,
    ],
  ])(
    "rejects invalid arguments %j before any request",
    async (args, message) => {
      // .invalid never resolves; a request would fail with a network error instead
      const r = await run(args);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(message);
      expect(r.stderr).not.toMatch(/ failed: /u);
    }
  );
});
