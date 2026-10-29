import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, test } from "@rstest/core";

import { runScript } from "./helpers.ts";

const ROOT = path.join(import.meta.dirname, "..");
const VENDORED = "a".repeat(40);
const MOVED = "b".repeat(40);
const NEWER = "c".repeat(40);
const OLDER = "2".repeat(40);

// Replaces fetch with fixed answers: releases/latest returns LATEST, v2.3.0 resolves to
// the vendored commit or, with MOVED set, to another one.
const FETCH_STUB = `
const shas = { "v2.2.0": "${OLDER}", "v2.3.0": process.env.MOVED ? "${MOVED}" : "${VENDORED}", "v2.4.0": "${NEWER}" };
globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (o) => new Response(JSON.stringify(o));
  if (u.endsWith("/releases/latest")) return json({ tag_name: process.env.LATEST });
  const m = /\\/commits\\/([^/]+)$/.exec(u);
  if (m) return json({ sha: shas[decodeURIComponent(m[1])] });
  if (u.endsWith("mc-mcp-server.cjs")) {
    return new Response("  let profile = {};\\n  try {\\n    profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));\\n");
  }
  return new Response("vendored\\n");
};
`;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

// A copy of the files the script reads and writes, pinned to v2.3.0 at VENDORED.
const workspace = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mc-vendor-"));
  dirs.push(dir);
  const manifest = "plugins/mission-control/.claude-plugin/plugin.json";
  for (const sub of [
    "scripts",
    "plugins/mission-control/.claude-plugin",
    "plugins/mission-control/scripts",
  ]) {
    mkdirSync(path.join(dir, sub), { recursive: true });
  }
  copyFileSync(
    path.join(ROOT, "scripts/vendor-upstream.ts"),
    path.join(dir, "scripts/vendor-upstream.ts")
  );
  copyFileSync(path.join(ROOT, manifest), path.join(dir, manifest));
  writeFileSync(
    path.join(dir, "upstream.json"),
    `${JSON.stringify({ commit: VENDORED, repo: "o/r", tag: "v2.3.0" })}\n`
  );
  writeFileSync(path.join(dir, "fetch-stub.mjs"), FETCH_STUB);
  const read = (file: string) => readFileSync(path.join(dir, file), "utf-8");
  return {
    outputs: () => {
      try {
        return read("outputs");
      } catch {
        return "";
      }
    },
    pinned: () =>
      JSON.parse(read("upstream.json")) as { tag: string; commit: string },
    run: (args: string[], env: Record<string, string> = {}) =>
      runScript(path.join(dir, "scripts/vendor-upstream.ts"), args, {
        env: { GITHUB_OUTPUT: path.join(dir, "outputs"), ...env },
        nodeArgs: ["--import", path.join(dir, "fetch-stub.mjs")],
      }),
    version: () => (JSON.parse(read(manifest)) as { version: string }).version,
  };
};

describe("vendor-upstream", () => {
  test.each([[[]], [["--latest"]]])(
    "refuses a vendored tag that upstream moved, without writing anything (%j)",
    async (args) => {
      const ws = workspace();
      const r = await ws.run(args, { LATEST: "v2.3.0", MOVED: "1" });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/upstream moved v2\.3\.0 .* --accept-moved/u);
      expect(ws.pinned().commit).toBe(VENDORED);
      expect(ws.outputs()).toBe("");
    }
  );

  test("still reports a moved tag when the latest release is older", async () => {
    const ws = workspace();
    const r = await ws.run(["--latest"], { LATEST: "v2.2.0", MOVED: "1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/upstream moved v2\.3\.0/u);
  });

  test("takes a moved tag with <tag> --accept-moved", async () => {
    const ws = workspace();
    const r = await ws.run(["v2.3.0", "--accept-moved"], { MOVED: "1" });
    expect(r.code, r.stderr).toBe(0);
    expect(ws.pinned()).toEqual({ commit: MOVED, repo: "o/r", tag: "v2.3.0" });
    expect(ws.outputs()).toContain("changed=true");
  });

  // the workflow passes its tag input as one argument
  test.each([["--accept-moved"], ["v2.3.0 --accept-moved"]])(
    "does not take a moved tag for the workflow input %j",
    async (input) => {
      const ws = workspace();
      const r = await ws.run([input], { MOVED: "1" });
      expect(r.code).toBe(1);
      expect(ws.pinned().commit).toBe(VENDORED);
    }
  );

  test("does not downgrade when the latest release is older", async () => {
    const ws = workspace();
    const r = await ws.run(["--latest"], { LATEST: "v2.2.0" });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/older than the vendored v2\.3\.0; unchanged/u);
    expect(ws.outputs()).toBe(
      `changed=false\ntag=v2.3.0\ncommit=${VENDORED}\n`
    );
    expect(ws.pinned().tag).toBe("v2.3.0");
  });

  test("vendors a newer release even if the vendored tag moved", async () => {
    const ws = workspace();
    const before = ws.version();
    const r = await ws.run(["--latest"], { LATEST: "v2.4.0", MOVED: "1" });
    expect(r.code, r.stderr).toBe(0);
    expect(ws.pinned()).toEqual({ commit: NEWER, repo: "o/r", tag: "v2.4.0" });
    expect(ws.version()).not.toBe(before);
  });

  test.each([
    [["v2.2.0", "v2.4.0"], /usage/u],
    [["v02.3.0"], /unexpected tag/u],
  ])("rejects arguments %j", async (args, message) => {
    const ws = workspace();
    const r = await ws.run(args);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(message);
    expect(ws.pinned().commit).toBe(VENDORED);
  });
});
