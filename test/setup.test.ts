import { writeFileSync } from "node:fs";
import path from "node:path";

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
import type { StubKey } from "./helpers.ts";

const SETUP = builtScript("dist", "setup.cjs");
const MARKETPLACE = "tvaliasek/mission-control-claude-plugin";
const PINNED = `${MARKETPLACE}#release`;
const PLUGIN = "mission-control@mission-control";
const CLAUDE_LIST = "claude plugin marketplace list --json";

// `claude plugin marketplace list --json` with the mission-control marketplace at ref.
const claudeListing = (ref?: string) =>
  JSON.stringify([
    {
      name: "mission-control",
      repo: MARKETPLACE,
      source: "github",
      ...(ref ? { ref } : {}),
    },
  ]);

// Copilot's settings file with the mission-control marketplace at ref.
const copilotSettings = (dir: string, ref?: string) =>
  writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({
      extraKnownMarketplaces: {
        "mission-control": {
          source: {
            repo: MARKETPLACE,
            source: "github",
            ...(ref ? { ref } : {}),
          },
        },
      },
    })
  );

const DAY = 86_400;
// what Mission Control lists for agent 7 after the new key (id 3) was issued
const AGENT_KEYS: StubKey[] = [
  {
    expires_at: null,
    id: 1,
    key_prefix: "mca_old11111",
    last_used_at: 1_700_000_000,
    name: "old-box",
    revoked_at: null,
  },
  {
    expires_at: null,
    id: 2,
    key_prefix: "mca_rev22222",
    last_used_at: null,
    name: "gone",
    revoked_at: 1_700_000_000,
  },
  {
    expires_at: null,
    id: 3,
    key_prefix: "mca_abcdef12",
    last_used_at: null,
    name: "new",
    revoked_at: null,
  },
  {
    expires_at: Math.floor(Date.now() / 1000) - DAY,
    id: 4,
    key_prefix: "mca_exp44444",
    last_used_at: null,
    name: "expired",
    revoked_at: null,
  },
];

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
        env: {
          COPILOT_HOME: bins.dir,
          MC_ADMIN_API_KEY: ADMIN_KEY,
          MC_URL: mc.url,
          PATH: bins.dir,
        },
        input: answers("y", mc.url, "build-box", "y"),
      });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toBe("");
      const calls = bins.calls();
      expect(callsOf(calls)).toEqual([
        "claude --version",
        CLAUDE_LIST,
        `claude plugin marketplace add ${PINNED}`,
        `claude plugin install ${PLUGIN}`,
        `claude plugin configure ${PLUGIN} --values-stdin`,
      ]);
      expect(JSON.parse(calls[4]?.input ?? "")).toEqual({
        agent_name: "build-box",
        mc_api_key: ISSUED_KEY,
        mc_url: mc.url,
      });
      expect(calls.some((c) => c.sawKeys)).toBe(false);
      expect(mc.requests.map((q) => `${q.method} ${q.url}`)).toEqual([
        "GET /api/agents/build-box",
        "POST /api/agents/register",
        // a newly registered agent has no earlier keys to list
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
        env: {
          COPILOT_HOME: bins.dir,
          MC_API_KEY: EXISTING_AGENT_KEY,
          MC_URL: mc.url,
          PATH: bins.dir,
        },
        input: answers("y", mc.url, "build-box", "n"),
      });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toBe(
        `export MC_URL='${mc.url}'\nexport MC_API_KEY='${EXISTING_AGENT_KEY}'\nexport MC_AGENT_NAME='build-box'\n`
      );
      expect(callsOf(bins.calls())).toEqual([
        "copilot --version",
        `copilot plugin marketplace add ${PINNED}`,
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
          env: {
            COPILOT_HOME: bins.dir,
            MC_API_KEY: key,
            MC_URL: mc.url,
            PATH: bins.dir,
          },
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

  test.each([
    ["Claude Code", "claude", "v0.1.0"],
    ["Copilot CLI", "copilot", undefined],
  ])(
    "leaves a %s marketplace on another ref as it is and says how to move it",
    async (_name, client, ref) => {
      const mc = await startMissionControl({ existingAgents: ["build-box"] });
      const bins = fakeBins([client], {
        outputs: { [CLAUDE_LIST]: claudeListing(ref) },
      });
      copilotSettings(bins.dir, ref);
      try {
        const r = await runScript(SETUP, [], {
          env: {
            COPILOT_HOME: bins.dir,
            MC_API_KEY: EXISTING_AGENT_KEY,
            MC_URL: mc.url,
            PATH: bins.dir,
          },
          input: answers("y", mc.url, "build-box", "n"),
        });
        expect(r.code, r.stderr).toBe(0);
        expect(r.stderr).toMatch(
          new RegExp(
            `follows ${ref ?? "the default branch"}, not release.*${client} plugin marketplace remove mission-control`,
            "u"
          )
        );
        const calls = callsOf(bins.calls());
        expect(calls.some((c) => c.includes("marketplace remove"))).toBe(false);
        expect(calls.some((c) => c.includes("marketplace add"))).toBe(false);
        expect(calls).toContain(`${client} plugin install ${PLUGIN}`);
      } finally {
        mc.close();
      }
    }
  );

  test.each([["claude"], ["copilot"]])(
    "leaves a %s marketplace on the release branch alone",
    async (client) => {
      const mc = await startMissionControl({ existingAgents: ["build-box"] });
      const bins = fakeBins([client], {
        outputs: { [CLAUDE_LIST]: claudeListing("release") },
      });
      copilotSettings(bins.dir, "release");
      try {
        const r = await runScript(SETUP, [], {
          env: {
            COPILOT_HOME: bins.dir,
            MC_API_KEY: EXISTING_AGENT_KEY,
            MC_URL: mc.url,
            PATH: bins.dir,
          },
          input: answers("y", mc.url, "build-box", "n"),
        });
        expect(r.code, r.stderr).toBe(0);
        expect(
          callsOf(bins.calls()).some((c) => c.includes("marketplace add"))
        ).toBe(false);
      } finally {
        mc.close();
      }
    }
  );

  test.each([
    [
      "another repository's",
      { repo: "someone/else", source: "github" },
      /different marketplace named mission-control is registered \(someone\/else\)/u,
    ],
    [
      "a directory's",
      { path: "/tmp/fork", source: "directory" },
      /registered from a source other than tvaliasek\/mission-control-claude-plugin/u,
    ],
  ])(
    "refuses to install over %s mission-control marketplace",
    async (_case, entry, message) => {
      const bins = fakeBins(["claude"], {
        outputs: {
          [CLAUDE_LIST]: JSON.stringify([
            { name: "mission-control", ...entry },
          ]),
        },
      });
      const r = await runScript(SETUP, [], {
        env: { COPILOT_HOME: bins.dir, PATH: bins.dir },
        input: answers("y", "https://mc.invalid", "build-box"),
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(message);
      expect(callsOf(bins.calls()).some((c) => c.includes("install"))).toBe(
        false
      );
    }
  );

  test("stops when Claude Code's marketplaces can't be listed", async () => {
    const bins = fakeBins(["claude"], {
      outputs: { [CLAUDE_LIST]: "not json" },
    });
    const r = await runScript(SETUP, [], {
      env: { COPILOT_HOME: bins.dir, PATH: bins.dir },
      input: answers("y", "https://mc.invalid", "build-box"),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(
      /could not read "claude plugin marketplace list --json"/u
    );
    // adding could re-point a foreign marketplace of that name
    expect(
      callsOf(bins.calls()).some((c) => c.includes("marketplace add"))
    ).toBe(false);
  });

  test("stops with a hint when adding the marketplace fails", async () => {
    const bins = fakeBins(["claude"], {
      exitCodes: { "claude plugin marketplace add": 1 },
      outputs: {
        [CLAUDE_LIST]: "[]",
        "claude plugin marketplace add":
          'Cannot add marketplace "mission-control": its source doesn\'t match its extraKnownMarketplaces entry in user or managed settings\n',
      },
    });
    const r = await runScript(SETUP, [], {
      env: { COPILOT_HOME: bins.dir, PATH: bins.dir },
      input: answers("y", "https://mc.invalid", "build-box"),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/source doesn't match/u);
    expect(r.stderr).toMatch(
      /edit or delete the mission-control entry of extraKnownMarketplaces/u
    );
    expect(callsOf(bins.calls())).not.toContain(
      `claude plugin install ${PLUGIN}`
    );
  });

  test("gives no Claude Code settings hint when Copilot can't add the marketplace", async () => {
    const bins = fakeBins(["copilot"], {
      exitCodes: { "copilot plugin marketplace add": 1 },
      outputs: {
        "copilot plugin marketplace add":
          "Failed to add marketplace: extraKnownMarketplaces is invalid\n",
      },
    });
    const r = await runScript(SETUP, [], {
      env: { COPILOT_HOME: bins.dir, PATH: bins.dir },
      input: answers("y", "https://mc.invalid", "build-box"),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/extraKnownMarketplaces is invalid/u);
    expect(r.stderr).not.toMatch(/Claude Code user settings/u);
  });

  test.each([
    // Copilot accepts comments in its settings file
    ["cannot read the settings of", "// mine\n{}\n"],
    ["has no settings for", undefined],
  ])(
    "continues with a registered Copilot marketplace it %s",
    async (_case, settings) => {
      const mc = await startMissionControl({ existingAgents: ["build-box"] });
      const bins = fakeBins(["copilot"], {
        exitCodes: { "copilot plugin marketplace add": 1 },
        outputs: {
          "copilot plugin marketplace add":
            'Failed to add marketplace: Marketplace "mission-control" already registered\n',
        },
      });
      if (settings !== undefined) {
        writeFileSync(path.join(bins.dir, "settings.json"), settings);
      }
      try {
        const r = await runScript(SETUP, [], {
          env: {
            COPILOT_HOME: bins.dir,
            MC_API_KEY: EXISTING_AGENT_KEY,
            MC_URL: mc.url,
            PATH: bins.dir,
          },
          input: answers("y", mc.url, "build-box", "n"),
        });
        expect(r.code, r.stderr).toBe(0);
        expect(r.stderr).toMatch(/registered already; continuing with it/u);
        expect(callsOf(bins.calls())).toContain(
          `copilot plugin install ${PLUGIN}`
        );
      } finally {
        mc.close();
      }
    }
  );

  test("fails when the marketplace can't be added and none is registered", async () => {
    const bins = fakeBins(["copilot"], {
      exitCodes: { "copilot plugin marketplace add": 1 },
    });
    const r = await runScript(SETUP, [], {
      env: { COPILOT_HOME: bins.dir, PATH: bins.dir },
      input: answers("y", "https://mc.invalid", "build-box"),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/copilot plugin marketplace exited with 1/u);
  });

  test.each([
    ["revokes", "y", ["DELETE /api/agents/7/keys 1"]],
    ["keeps", "n", []],
  ])(
    "%s the agent's other active keys as answered",
    async (_case, answer, deletes) => {
      const mc = await startMissionControl({
        agentKeys: AGENT_KEYS,
        existingAgents: ["build-box"],
      });
      const bins = fakeBins(["claude"]);
      try {
        const r = await runScript(SETUP, [], {
          env: {
            COPILOT_HOME: bins.dir,
            MC_ADMIN_API_KEY: ADMIN_KEY,
            MC_URL: mc.url,
            PATH: bins.dir,
          },
          input: answers("y", mc.url, "build-box", "y", "y", answer),
        });
        expect(r.code, r.stderr).toBe(0);
        // only the active, unexpired key that isn't the new one is offered
        expect(r.stderr).toMatch(
          /mca_old11111… "old-box" \(id 1\), last used 2023-11-14/u
        );
        expect(r.stderr).not.toMatch(
          /mca_rev22222|mca_exp44444|mca_abcdef12… "new"/u
        );
        expect(
          mc.requests
            .filter((q) => q.method === "DELETE")
            .map((q) => `${q.method} ${q.url} ${String(q.body.key_id)}`)
        ).toEqual(deletes);
      } finally {
        mc.close();
      }
    }
  );

  test("reports each key it could not revoke and exits 2", async () => {
    const mc = await startMissionControl({
      agentKeys: [
        ...AGENT_KEYS,
        {
          expires_at: null,
          id: 5,
          key_prefix: "mca_old55555",
          last_used_at: null,
          name: "other-box",
          revoked_at: null,
        },
      ],
      existingAgents: ["build-box"],
      // every revocation fails
      handler: (req, res) => {
        if (req.method !== "DELETE") {
          return false;
        }
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "boom" }));
        return true;
      },
    });
    const bins = fakeBins(["claude"]);
    try {
      const r = await runScript(SETUP, [], {
        env: {
          COPILOT_HOME: bins.dir,
          MC_ADMIN_API_KEY: ADMIN_KEY,
          MC_URL: mc.url,
          PATH: bins.dir,
        },
        input: answers("y", mc.url, "build-box", "y", "y", "y"),
      });
      expect(r.code, r.stderr).toBe(2);
      expect(r.stderr).toMatch(/warning: key id 1 not revoked: HTTP 500 boom/u);
      expect(r.stderr).toMatch(/warning: key id 5 not revoked: HTTP 500 boom/u);
      // one request per key, one after the other
      expect(
        mc.requests
          .filter((q) => q.method === "DELETE")
          .map((q) => q.body.key_id)
      ).toEqual([1, 5]);
    } finally {
      mc.close();
    }
  });

  test("does not offer to revoke earlier keys when the new key is only printed for Copilot", async () => {
    const mc = await startMissionControl({
      agentKeys: AGENT_KEYS,
      existingAgents: ["build-box"],
    });
    const bins = fakeBins(["copilot"]);
    try {
      const r = await runScript(SETUP, [], {
        env: {
          COPILOT_HOME: bins.dir,
          MC_ADMIN_API_KEY: ADMIN_KEY,
          MC_URL: mc.url,
          PATH: bins.dir,
        },
        input: answers("y", mc.url, "build-box", "y", "y"),
      });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/export MC_API_KEY=/u);
      expect(
        mc.requests.filter(
          (q) => q.url.endsWith("/keys") && q.method !== "POST"
        )
      ).toEqual([]);
    } finally {
      mc.close();
    }
  });

  test("keeps earlier keys when piped input ends at the revoke question", async () => {
    const mc = await startMissionControl({
      agentKeys: AGENT_KEYS,
      existingAgents: ["build-box"],
    });
    const bins = fakeBins(["claude"]);
    try {
      const r = await runScript(SETUP, [], {
        env: {
          COPILOT_HOME: bins.dir,
          MC_ADMIN_API_KEY: ADMIN_KEY,
          MC_URL: mc.url,
          PATH: bins.dir,
        },
        input: answers("y", mc.url, "build-box", "y", "y"),
      });
      // piped input answers the default, no; a terminal's Ctrl-D exits 2 instead
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/earlier keys left active/u);
      expect(callsOf(bins.calls())).toContain(
        `claude plugin configure ${PLUGIN} --values-stdin`
      );
      expect(mc.requests.some((q) => q.method === "DELETE")).toBe(false);
    } finally {
      mc.close();
    }
  });

  test("exits 2 and keeps earlier keys on an invalid answer at the revoke question", async () => {
    const mc = await startMissionControl({
      agentKeys: AGENT_KEYS,
      existingAgents: ["build-box"],
    });
    const bins = fakeBins(["claude"]);
    try {
      const r = await runScript(SETUP, [], {
        env: {
          COPILOT_HOME: bins.dir,
          MC_ADMIN_API_KEY: ADMIN_KEY,
          MC_URL: mc.url,
          PATH: bins.dir,
        },
        input: answers("y", mc.url, "build-box", "y", "y", "yse"),
      });
      expect(r.code, r.stderr).toBe(2);
      expect(r.stderr).toMatch(/answer y or n; earlier keys left active/u);
      expect(callsOf(bins.calls())).toContain(
        `claude plugin configure ${PLUGIN} --values-stdin`
      );
      expect(mc.requests.some((q) => q.method === "DELETE")).toBe(false);
    } finally {
      mc.close();
    }
  });

  test("warns and exits 2 when the earlier keys can't be listed", async () => {
    const mc = await startMissionControl({
      agentKeys: AGENT_KEYS,
      existingAgents: ["build-box"],
      handler: (req, res) => {
        if (req.method !== "GET" || !req.url?.endsWith("/keys")) {
          return false;
        }
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "db" }));
        return true;
      },
    });
    const bins = fakeBins(["claude"]);
    try {
      const r = await runScript(SETUP, [], {
        env: {
          COPILOT_HOME: bins.dir,
          MC_ADMIN_API_KEY: ADMIN_KEY,
          MC_URL: mc.url,
          PATH: bins.dir,
        },
        input: answers("y", mc.url, "build-box", "y", "y"),
      });
      expect(r.code, r.stderr).toBe(2);
      expect(r.stderr).toMatch(
        /warning: could not list earlier keys, none revoked: HTTP 500 db/u
      );
    } finally {
      mc.close();
    }
  });

  test("does not revoke earlier keys when configuring Claude Code fails", async () => {
    const mc = await startMissionControl({
      agentKeys: AGENT_KEYS,
      existingAgents: ["build-box"],
    });
    const bins = fakeBins(["claude"], {
      exitCodes: { "claude plugin configure": 3 },
    });
    try {
      const r = await runScript(SETUP, [], {
        env: {
          COPILOT_HOME: bins.dir,
          MC_ADMIN_API_KEY: ADMIN_KEY,
          MC_URL: mc.url,
          PATH: bins.dir,
        },
        input: answers("y", mc.url, "build-box", "y", "y", "y"),
      });
      expect(r.code).toBe(1);
      expect(
        mc.requests.some((q) => q.url.endsWith("/keys") && q.method !== "POST")
      ).toBe(false);
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
        env: {
          COPILOT_HOME: bins.dir,
          MC_ADMIN_API_KEY: ADMIN_KEY,
          MC_URL: mc.url,
          PATH: bins.dir,
        },
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
        env: {
          COPILOT_HOME: bins.dir,
          MC_ADMIN_API_KEY: ADMIN_KEY,
          MC_URL: mc.url,
          PATH: bins.dir,
        },
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
        env: {
          COPILOT_HOME: bins.dir,
          MC_ADMIN_API_KEY: ADMIN_KEY,
          MC_URL: mc.url,
          PATH: bins.dir,
        },
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
        env: {
          COPILOT_HOME: bins.dir,
          MC_ADMIN_API_KEY: ADMIN_KEY,
          MC_URL: mc.url,
          PATH: bins.dir,
        },
        input: answers("y", "y", mc.url, "build-box", "y"),
      });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(`${ISSUED_KEY}\n`);
      expect(r.stdout).toContain(`export MC_API_KEY='${ISSUED_KEY}'`);
    } finally {
      mc.close();
    }
  });

  test("ignores a key from the environment exported for another URL", async () => {
    const mc = await startMissionControl({ existingAgents: ["build-box"] });
    const bins = fakeBins(["copilot"]);
    try {
      const r = await runScript(SETUP, [], {
        env: {
          COPILOT_HOME: bins.dir,
          MC_API_KEY: EXISTING_AGENT_KEY,
          MC_URL: "https://other.example.com",
          PATH: bins.dir,
        },
        input: answers("y", mc.url, "build-box", "n"),
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/ignoring MC_API_KEY/u);
      expect(r.stderr).toMatch(/set MC_API_KEY and MC_URL instead/u);
      expect(mc.requests).toHaveLength(0);
    } finally {
      mc.close();
    }
  });

  test("refuses a pasted key when the admin check is inconclusive", async () => {
    const mc = await startMissionControl({
      existingAgents: ["build-box"],
      // e.g. rate limiting: says nothing about whether the key is an admin key
      handler: (req, res) => {
        if (!req.url?.endsWith("/keys")) {
          return false;
        }
        res.statusCode = 429;
        res.end("{}");
        return true;
      },
    });
    const bins = fakeBins(["copilot"]);
    try {
      const r = await runScript(SETUP, [], {
        env: {
          COPILOT_HOME: bins.dir,
          MC_API_KEY: ADMIN_KEY,
          MC_URL: mc.url,
          PATH: bins.dir,
        },
        input: answers("y", mc.url, "build-box", "n"),
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/could not check .* HTTP 429/u);
      expect(r.stdout).toBe("");
    } finally {
      mc.close();
    }
  });

  test("stops at a plain-HTTP URL to another machine unless confirmed", async () => {
    const bins = fakeBins(["claude"]);
    const r = await runScript(SETUP, [], {
      env: { COPILOT_HOME: bins.dir, PATH: bins.dir },
      input: answers("y", "http://mc.invalid", ""),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/use an HTTPS URL/u);
    expect(callsOf(bins.calls())).toEqual(["claude --version"]);
  });

  test("fails on an answer that is not yes or no, without echoing it", async () => {
    const bins = fakeBins(["claude"]);
    const r = await runScript(SETUP, [], {
      env: { COPILOT_HOME: bins.dir, PATH: bins.dir },
      input: answers("mca_secret_pasted_here"),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/answer y or n/u);
    expect(r.stderr).not.toContain("mca_secret");
    expect(callsOf(bins.calls())).toEqual(["claude --version"]);
  });

  test("fails when neither client is installed", async () => {
    const bins = fakeBins([]);
    const r = await runScript(SETUP, [], {
      env: { COPILOT_HOME: bins.dir, PATH: bins.dir },
      input: "",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/neither claude nor copilot/u);
  });

  test("rejects an invalid agent name before installing anything", async () => {
    const bins = fakeBins(["claude"]);
    const r = await runScript(SETUP, [], {
      env: { COPILOT_HOME: bins.dir, PATH: bins.dir },
      input: answers("y", "https://mc.invalid", "-bad"),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/agent name must be/u);
    expect(callsOf(bins.calls())).toEqual(["claude --version"]);
  });
});
