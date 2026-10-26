import { afterAll, describe, expect, test } from "@rstest/core";

import {
  ADMIN_KEY,
  EXISTING_AGENT_KEY,
  ISSUED_KEY,
  builtScript,
  fakeBins,
  removeTempDirs,
  runScript,
  startMissionControl,
} from "./helpers.ts";

const SETUP = builtScript("dist", "setup.cjs");
const MARKETPLACE = "tvaliasek/mission-control-claude-plugin";
const PLUGIN = "mission-control@mission-control";

afterAll(removeTempDirs);

// Answers in the order setup asks: client confirmations, URL, agent name, key choice.
const answers = (...lines: string[]) => `${lines.join("\n")}\n`;

const callsOf = (calls: { command: string; argv: string[] }[]) =>
  calls.map((c) => `${c.command} ${c.argv.join(" ")}`);

describe("setup", () => {
  test("installs and configures Claude Code with a newly issued key", async () => {
    const mc = await startMissionControl();
    const bins = fakeBins(["claude"]);
    try {
      const r = await runScript(SETUP, [], {
        env: { MC_ADMIN_API_KEY: ADMIN_KEY, PATH: bins.dir },
        input: answers("y", mc.url, "build-box", "y"),
      });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toBe("");
      const calls = bins.calls();
      expect(callsOf(calls)).toEqual([
        "claude --version",
        `claude plugin marketplace add ${MARKETPLACE}`,
        `claude plugin install ${PLUGIN}`,
        `claude plugin configure ${PLUGIN} --values-stdin`,
      ]);
      expect(JSON.parse(calls[3]?.input ?? "")).toEqual({
        agent_name: "build-box",
        mc_api_key: ISSUED_KEY,
        mc_url: mc.url,
      });
      expect(calls.some((c) => c.sawKeys)).toBe(false);
      expect(mc.requests.map((q) => `${q.method} ${q.url}`)).toEqual([
        "GET /api/agents/build-box",
        "POST /api/agents/register",
        "POST /api/agents/7/keys",
      ]);
      expect(r.stderr).not.toContain(ADMIN_KEY);
    } finally {
      mc.close();
    }
  });

  test("installs the Copilot CLI plugin and prints exports for an existing key", async () => {
    const mc = await startMissionControl({ existingAgents: ["build-box"] });
    const bins = fakeBins(["copilot"]);
    try {
      const r = await runScript(SETUP, [], {
        env: { MC_API_KEY: EXISTING_AGENT_KEY, PATH: bins.dir },
        input: answers("y", mc.url, "build-box", "n"),
      });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toBe(
        `export MC_URL='${mc.url}'\nexport MC_API_KEY='${EXISTING_AGENT_KEY}'\nexport MC_AGENT_NAME='build-box'\n`
      );
      expect(callsOf(bins.calls())).toEqual([
        "copilot --version",
        `copilot plugin marketplace add ${MARKETPLACE}`,
        `copilot plugin install ${PLUGIN}`,
      ]);
      // the pasted key is verified with read-only requests, nothing is issued
      expect(mc.requests.map((q) => `${q.method} ${q.url} ${q.key}`)).toEqual([
        `GET /api/agents/build-box ${EXISTING_AGENT_KEY}`,
        `GET /api/agents/build-box/keys ${EXISTING_AGENT_KEY}`,
      ]);
      expect(r.stderr).toMatch(/key accepted/u);
    } finally {
      mc.close();
    }
  });

  test.each([
    [
      "a key of another agent",
      EXISTING_AGENT_KEY,
      "other-box",
      ["other-box"],
      /HTTP 401/u,
    ],
    [
      "an admin key",
      ADMIN_KEY,
      "build-box",
      ["build-box"],
      /this is an admin key/u,
    ],
    [
      "a key for a missing agent",
      EXISTING_AGENT_KEY,
      "build-box",
      [],
      /has no agent "build-box"/u,
    ],
  ])(
    "rejects a pasted key that is %s",
    async (_case, key, agent, existing, message) => {
      const mc = await startMissionControl({ existingAgents: existing });
      const bins = fakeBins(["copilot"]);
      try {
        const r = await runScript(SETUP, [], {
          env: { MC_API_KEY: key, PATH: bins.dir },
          input: answers("y", mc.url, agent, "n"),
        });
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(message);
        expect(r.stdout).toBe("");
      } finally {
        mc.close();
      }
    }
  );

  test("accepts a Copilot marketplace that is already registered", async () => {
    const mc = await startMissionControl({ existingAgents: ["build-box"] });
    const bins = fakeBins(["copilot"], {
      exitCodes: { "copilot plugin marketplace add": 1 },
      outputs: {
        "copilot plugin marketplace add":
          'Failed to add marketplace: Marketplace "mission-control" already registered\n',
      },
    });
    try {
      const r = await runScript(SETUP, [], {
        env: { MC_API_KEY: EXISTING_AGENT_KEY, PATH: bins.dir },
        input: answers("y", mc.url, "build-box", "n"),
      });
      expect(r.code, r.stderr).toBe(0);
      expect(callsOf(bins.calls())).toContain(
        `copilot plugin install ${PLUGIN}`
      );
    } finally {
      mc.close();
    }
  });

  test("stops before any key is issued when the plugin install fails", async () => {
    const mc = await startMissionControl();
    const bins = fakeBins(["claude"], {
      exitCodes: { "claude plugin install": 2 },
    });
    try {
      const r = await runScript(SETUP, [], {
        env: { MC_ADMIN_API_KEY: ADMIN_KEY, PATH: bins.dir },
        input: answers("y", mc.url, "build-box", "y"),
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/exited with 2/u);
      expect(mc.requests).toHaveLength(0);
    } finally {
      mc.close();
    }
  });

  test("does not issue a key for an existing agent unless confirmed", async () => {
    const mc = await startMissionControl({ existingAgents: ["build-box"] });
    const bins = fakeBins(["claude"]);
    try {
      const r = await runScript(SETUP, [], {
        env: { MC_ADMIN_API_KEY: ADMIN_KEY, PATH: bins.dir },
        input: answers("y", mc.url, "build-box", "y", "n"),
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/already exists; not issuing/u);
      expect(mc.requests.map((q) => q.method)).toEqual(["GET"]);
    } finally {
      mc.close();
    }
  });

  test("prints a newly issued key when configuring Claude Code fails", async () => {
    const mc = await startMissionControl();
    const bins = fakeBins(["claude"], {
      exitCodes: { "claude plugin configure": 3 },
    });
    try {
      const r = await runScript(SETUP, [], {
        env: { MC_ADMIN_API_KEY: ADMIN_KEY, PATH: bins.dir },
        input: answers("y", mc.url, "build-box", "y"),
      });
      expect(r.code).toBe(1);
      expect(r.stdout).toBe(`${ISSUED_KEY}\n`);
    } finally {
      mc.close();
    }
  });

  test("still prints the Copilot exports when configuring Claude Code fails", async () => {
    const mc = await startMissionControl();
    const bins = fakeBins(["claude", "copilot"], {
      exitCodes: { "claude plugin configure": 3 },
    });
    try {
      const r = await runScript(SETUP, [], {
        env: { MC_ADMIN_API_KEY: ADMIN_KEY, PATH: bins.dir },
        input: answers("y", "y", mc.url, "build-box", "y"),
      });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(`${ISSUED_KEY}\n`);
      expect(r.stdout).toContain(`export MC_API_KEY='${ISSUED_KEY}'`);
    } finally {
      mc.close();
    }
  });

  test("fails when neither client is installed", async () => {
    const bins = fakeBins([]);
    const r = await runScript(SETUP, [], {
      env: { PATH: bins.dir },
      input: "",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/neither claude nor copilot/u);
  });

  test("rejects an invalid agent name before installing anything", async () => {
    const bins = fakeBins(["claude"]);
    const r = await runScript(SETUP, [], {
      env: { PATH: bins.dir },
      input: answers("y", "https://mc.example.com", "-bad"),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/agent name must be/u);
    expect(callsOf(bins.calls())).toEqual(["claude --version"]);
  });
});
