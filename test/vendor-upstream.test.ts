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
  if (m) {
    const sha = shas[decodeURIComponent(m[1])];
    return sha ? json({ sha }) : new Response("{}", { status: 422 });
  }
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
const DEFAULT_PIN = { commit: VENDORED, repo: "o/r", tag: "v2.3.0" };

const workspace = (pin: Record<string, string> = DEFAULT_PIN) => {
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
  writeFileSync(path.join(dir, "upstream.json"), `${JSON.stringify(pin)}\n`);
  writeFileSync(path.join(dir, "fetch-stub.mjs"), FETCH_STUB);
  const read = (file: string) => readFileSync(path.join(dir, file), "utf-8");
  return {
    pinned: () =>
      JSON.parse(read("upstream.json")) as { tag: string; commit: string },
    read,
    run: (args: string[], env: Record<string, string> = {}) =>
      runScript(path.join(dir, "scripts/vendor-upstream.ts"), args, {
        env,
        nodeArgs: ["--import", path.join(dir, "fetch-stub.mjs")],
      }),
    version: () => (JSON.parse(read(manifest)) as { version: string }).version,
  };
};

describe("vendor-upstream", () => {
  test.each([[[]], [["--latest"]]])(
    "refuses the vendored tag once upstream moved it, writing nothing (%j)",
    async (args) => {
      const ws = workspace();
      const r = await ws.run(args, { LATEST: "v2.3.0", MOVED: "1" });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(
        /upstream moved v2\.3\.0 from a{40} to b{40}.*by hand/u
      );
      expect(ws.pinned().commit).toBe(VENDORED);
    }
  );

  test("takes a moved tag after its commit was set in upstream.json by hand", async () => {
    const ws = workspace({ ...DEFAULT_PIN, commit: MOVED });
    const r = await ws.run([], { MOVED: "1" });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/unchanged at o\/r@v2\.3\.0 \(b{40}\)/u);
    expect(
      ws.read("plugins/mission-control/scripts/LICENSE.mission-control")
    ).toBe("vendored\n");
  });

  test("does not downgrade when the latest release is older", async () => {
    const ws = workspace();
    const r = await ws.run(["--latest"], { LATEST: "v2.2.0" });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/older than the vendored v2\.3\.0; unchanged/u);
    expect(ws.pinned()).toEqual(DEFAULT_PIN);
  });

  test("vendors a newer release", async () => {
    const ws = workspace();
    const before = ws.version();
    const r = await ws.run(["--latest"], { LATEST: "v2.4.0" });
    expect(r.code, r.stderr).toBe(0);
    expect(ws.pinned()).toEqual({ commit: NEWER, repo: "o/r", tag: "v2.4.0" });
    expect(ws.version()).not.toBe(before);
  });

  test("leaves an unchanged tag alone", async () => {
    const ws = workspace();
    const before = ws.version();
    const r = await ws.run([]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/unchanged at o\/r@v2\.3\.0/u);
    expect(ws.version()).toBe(before);
  });

  test.each([
    [["v2.2.0", "v2.4.0"], /usage/u],
    [["v02.3.0"], /unexpected tag/u],
    [["v2.3.0", "--accept-moved"], /usage/u],
    [["v2.2.0"], /v2\.2\.0 is older than the vendored v2\.3\.0/u],
  ])("rejects arguments %j", async (args, message) => {
    const ws = workspace();
    const r = await ws.run(args);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(message);
    expect(ws.pinned()).toEqual(DEFAULT_PIN);
  });

  test.each([
    [{ ...DEFAULT_PIN, repo: "o/r/../x" }],
    [{ ...DEFAULT_PIN, repo: "o/.." }],
    [{ ...DEFAULT_PIN, tag: "v2.3" }],
  ])("refuses an invalid upstream.json %j", async (pin) => {
    const ws = workspace(pin);
    const r = await ws.run([]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unexpected repo, tag or commit/u);
  });
});
