import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

const startMissionControl = async () => {
  const seen: { url: string; key: string | undefined }[] = [];
  const server = createServer((req, res) => {
    seen.push({ key: req.headers["x-api-key"] as string, url: req.url ?? "" });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ agents: [] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    close: () => server.close(),
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
