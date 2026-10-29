import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "@rstest/core";

// Runs the built launcher, which loads the vendored MCP server next to it.
const LAUNCHER = path.join(
  import.meta.dirname,
  "..",
  "plugins",
  "mission-control",
  "scripts",
  "mc-mcp-launch.cjs"
);

// The unexpanded placeholder Copilot CLI passes through, e.g. "${user_config.mc_url}".
const placeholder = (name: string) => `\${user_config.${name}}`;

// Environment as each client produces it from .mcp.json; the tests fill in the mock URL.
const CLAUDE_CODE_ENV = {
  MC_API_KEY: "mca_configured",
  MC_API_KEY_FALLBACK: "",
  MC_URL: "",
  MC_URL_FALLBACK: "",
};
const COPILOT_ENV = {
  MC_API_KEY: placeholder("mc_api_key"),
  MC_API_KEY_FALLBACK: "mca_from_shell",
  MC_URL: placeholder("mc_url"),
  MC_URL_FALLBACK: "",
};

const startMissionControl = async (redirectTo?: string) => {
  const seen: { url: string; key: string | undefined }[] = [];
  const cookies: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    seen.push({ key: req.headers["x-api-key"] as string, url: req.url ?? "" });
    cookies.push(req.headers.cookie);
    if (redirectTo) {
      res.statusCode = 307;
      res.setHeader("Location", `${redirectTo}${req.url ?? ""}`);
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ agents: [] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    close: () => server.close(),
    cookies,
    seen,
    url: `http://127.0.0.1:${port}`,
  };
};

// Starts the launcher, calls one MCP tool and returns the tool result text.
const callTool = async (env: Record<string, string>, tool: string) => {
  const child = spawn(process.execPath, [LAUNCHER], {
    // HOME is isolated so an mc-cli profile on the test machine can't interfere
    env: { HOME: import.meta.dirname, PATH: process.env.PATH ?? "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const send = (message: Record<string, unknown>) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  send({
    id: 1,
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
      protocolVersion: "2024-11-05",
    },
  });
  send({ id: 2, method: "tools/call", params: { arguments: {}, name: tool } });
  // the server answers each line; close stdin once both answers are in
  // (stdout also ends when the launcher exits early)
  let stdout = "";
  for await (const chunk of child.stdout) {
    stdout += String(chunk);
    if (stdout.split("\n").filter(Boolean).length >= 2) {
      break;
    }
  }
  child.stdin.end();
  const [code] = (await once(child, "close")) as [number | null];
  return { code, stderr, stdout };
};

describe("mc-mcp-launch", () => {
  test("uses the Claude Code configuration when it resolved", async () => {
    const mc = await startMissionControl();
    try {
      const r = await callTool(
        {
          ...CLAUDE_CODE_ENV,
          MC_API_KEY_FALLBACK: "mca_from_shell",
          MC_URL: mc.url,
          MC_URL_FALLBACK: "http://127.0.0.1:1",
        },
        "mc_list_agents"
      );
      expect(r.stdout, r.stderr).toContain('"id":2');
      expect(mc.seen).toEqual([{ key: "mca_configured", url: "/api/agents" }]);
    } finally {
      mc.close();
    }
  });

  test("falls back to the shell environment under Copilot CLI", async () => {
    const mc = await startMissionControl();
    try {
      const r = await callTool(
        { ...COPILOT_ENV, MC_URL_FALLBACK: mc.url },
        "mc_list_agents"
      );
      expect(r.stdout, r.stderr).toContain('"id":2');
      expect(mc.seen).toEqual([{ key: "mca_from_shell", url: "/api/agents" }]);
    } finally {
      mc.close();
    }
  });

  test("never pairs a configured URL with a key from the shell", async () => {
    const configured = await startMissionControl();
    const shell = await startMissionControl();
    try {
      const r = await callTool(
        {
          ...COPILOT_ENV,
          MC_API_KEY_FALLBACK: "mca_from_shell",
          MC_URL: configured.url,
          MC_URL_FALLBACK: shell.url,
        },
        "mc_list_agents"
      );
      expect(r.stdout, r.stderr).toContain('"id":2');
      expect(configured.seen).toEqual([]);
      expect(shell.seen).toEqual([
        { key: "mca_from_shell", url: "/api/agents" },
      ]);
    } finally {
      configured.close();
      shell.close();
    }
  });

  test("ignores whitespace around the configured key", async () => {
    const mc = await startMissionControl();
    try {
      const r = await callTool(
        { ...CLAUDE_CODE_ENV, MC_API_KEY: " mca_configured\n", MC_URL: mc.url },
        "mc_list_agents"
      );
      expect(r.stdout, r.stderr).toContain('"id":2');
      expect(mc.seen).toEqual([{ key: "mca_configured", url: "/api/agents" }]);
    } finally {
      mc.close();
    }
  });

  test("does not send the key to a redirect target", async () => {
    const target = await startMissionControl();
    const mc = await startMissionControl(target.url);
    try {
      const r = await callTool(
        { ...CLAUDE_CODE_ENV, MC_URL: mc.url },
        "mc_list_agents"
      );
      expect(r.stdout, r.stderr).toContain('"id":2');
      expect(r.stdout).toMatch(/answered with a redirect/u);
      expect(mc.seen).toHaveLength(1);
      expect(target.seen).toEqual([]);
    } finally {
      mc.close();
      target.close();
    }
  });

  test("sends neither MC_COOKIE nor a saved mc-cli session cookie", async () => {
    const mc = await startMissionControl();
    // a profile as `mc-cli login` saves it; its cookie would override the agent key
    const home = mkdtempSync(path.join(tmpdir(), "mc-home-"));
    const profiles = path.join(home, ".mission-control", "profiles");
    mkdirSync(profiles, { recursive: true });
    writeFileSync(
      path.join(profiles, "default.json"),
      JSON.stringify({ cookie: "mc-session=profile", url: mc.url })
    );
    try {
      const r = await callTool(
        {
          ...CLAUDE_CODE_ENV,
          HOME: home,
          MC_COOKIE: "mc-session=shell",
          MC_URL: mc.url,
        },
        "mc_list_agents"
      );
      expect(r.stdout, r.stderr).toContain('"id":2');
      expect(mc.seen).toEqual([{ key: "mca_configured", url: "/api/agents" }]);
      expect(mc.cookies).toEqual([undefined]);
    } finally {
      mc.close();
      rmSync(home, { force: true, recursive: true });
    }
  });

  test("refuses a key with invalid characters without echoing it", async () => {
    const r = await callTool(
      {
        ...CLAUDE_CODE_ENV,
        MC_API_KEY: "SECRETVALUE\nx",
        MC_URL: "http://127.0.0.1:1",
      },
      "mc_list_agents"
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/invalid characters/u);
    expect(`${r.stdout}${r.stderr}`).not.toContain("SECRETVALUE");
  });

  test("exits with instructions when neither source provides values", async () => {
    const r = await callTool(
      { ...COPILOT_ENV, MC_API_KEY_FALLBACK: "", MC_URL_FALLBACK: "" },
      "mc_list_agents"
    );
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/export MC_URL and MC_API_KEY/u);
  });
});
