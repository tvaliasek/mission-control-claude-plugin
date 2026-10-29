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
const moved = { 1: "${MOVED}", 2: "${"d".repeat(40)}" }[process.env.MOVED];
const shas = { "v2.2.0": process.env.MOVED_OLDER ? "${"f".repeat(40)}" : "${OLDER}", "v2.3.0": moved ?? "${VENDORED}", "v2.4.0": "${NEWER}" };
if (process.env.DELETED) delete shas["v2.3.0"];
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

const workspace = (pin: Record<string, unknown> = DEFAULT_PIN) => {
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
    outputs: () => {
      try {
        return read("outputs");
      } catch {
        return "";
      }
    },
    pinned: () =>
      JSON.parse(read("upstream.json")) as { tag: string; commit: string },
    read,
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
    expect(ws.pinned()).toMatchObject({
      commit: MOVED,
      repo: "o/r",
      tag: "v2.3.0",
    });
    expect(ws.outputs()).toContain("changed=true");
  });

  // the workflow passes its tag input as one argument
  test.each([["--accept-moved"], ["v2.3.0 --accept-moved"]])(
    "does not take a moved tag for the workflow input %j",
    async (input) => {
      const ws = workspace();
      const r = await ws.run([input], { MOVED: "1" });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/unexpected tag/u);
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
    expect(ws.pinned()).toMatchObject({
      commit: NEWER,
      repo: "o/r",
      tag: "v2.4.0",
    });
    expect(ws.version()).not.toBe(before);
  });

  test("rolls back to an older tag, past a moved one only with --accept-moved", async () => {
    const plain = workspace();
    const ok = await plain.run(["v2.2.0"]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(plain.pinned().tag).toBe("v2.2.0");

    const refused = workspace();
    const r = await refused.run(["v2.2.0"], { MOVED: "1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/upstream moved v2\.3\.0 .* roll back with/u);
    expect(refused.pinned().tag).toBe("v2.3.0");

    const accepted = workspace();
    const a = await accepted.run(["v2.2.0", "--accept-moved"], { MOVED: "1" });
    expect(a.code, a.stderr).toBe(0);
    expect(accepted.pinned()).toMatchObject({
      commit: OLDER,
      repo: "o/r",
      tag: "v2.2.0",
    });
  });

  test("names a vendored tag that upstream removed, and rolls back past it", async () => {
    const ws = workspace();
    const r = await ws.run(["--latest"], { DELETED: "1", LATEST: "v2.2.0" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(
      /the vendored v2\.3\.0 no longer exists upstream/u
    );
    expect(ws.outputs()).toBe("");

    const rollback = workspace();
    const ok = await rollback.run(["v2.2.0", "--accept-moved"], {
      DELETED: "1",
    });
    expect(ok.code, ok.stderr).toBe(0);
    expect(rollback.pinned().tag).toBe("v2.2.0");
  });

  test("a rollback turns down the moved commit, and only that one", async () => {
    const ws = workspace();
    const back = await ws.run(["v2.2.0", "--accept-moved"], { MOVED: "1" });
    expect(back.code, back.stderr).toBe(0);
    expect(JSON.parse(ws.read("upstream.json"))).toMatchObject({
      known: { "v2.2.0": OLDER, "v2.3.0": VENDORED },
      rejected: { "v2.3.0": MOVED },
    });

    // the turned-down commit is not proposed again...
    const same = await ws.run(["--latest"], { LATEST: "v2.3.0", MOVED: "1" });
    expect(same.code, same.stderr).toBe(0);
    expect(same.stdout).toMatch(
      /rejected by a rollback; unchanged at v2\.2\.0/u
    );
    expect(ws.outputs()).toContain("changed=false");
    expect(ws.pinned().tag).toBe("v2.2.0");

    // ...but the tag moving anywhere else fails again
    const again = await ws.run(["--latest"], { LATEST: "v2.3.0", MOVED: "2" });
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(
      /upstream moved v2\.3\.0 from a{40} to d{40}/u
    );

    // and a person can still take it on purpose
    const take = await ws.run(["v2.3.0", "--accept-moved"], { MOVED: "1" });
    expect(take.code, take.stderr).toBe(0);
    expect(JSON.parse(ws.read("upstream.json"))).toMatchObject({
      commit: MOVED,
      rejected: {},
      tag: "v2.3.0",
    });
  });

  test("still checks the rolled-back tag while the turned-down one is latest", async () => {
    const ws = workspace({
      commit: OLDER,
      known: { "v2.2.0": OLDER, "v2.3.0": VENDORED },
      rejected: { "v2.3.0": MOVED },
      repo: "o/r",
      tag: "v2.2.0",
    });
    const ok = await ws.run(["--latest"], { LATEST: "v2.3.0", MOVED: "1" });
    expect(ok.code, ok.stderr).toBe(0);

    const r = await ws.run(["--latest"], {
      LATEST: "v2.3.0",
      MOVED: "1",
      MOVED_OLDER: "1",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/upstream moved v2\.2\.0 from 2{40} to f{40}/u);
  });

  test("does not roll back to a recorded tag that moved too", async () => {
    const ws = workspace({
      ...DEFAULT_PIN,
      known: { "v2.2.0": "e".repeat(40) },
    });
    const r = await ws.run(["v2.2.0", "--accept-moved"], { MOVED: "1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/upstream moved v2\.2\.0 from e{40} to 2{40}/u);
    expect(ws.pinned().tag).toBe("v2.3.0");
  });

  test("does not offer taking a vendored tag that was removed", async () => {
    const ws = workspace();
    const r = await ws.run([], { DELETED: "1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no longer exists upstream.*roll back with/u);
    expect(r.stderr).not.toMatch(/take it with/u);
  });

  test.each([
    [{ commit: VENDORED, repo: "o/r/../x", tag: "v2.3.0" }],
    [{ commit: VENDORED, repo: "o/..", tag: "v2.3.0" }],
    [{ commit: VENDORED, repo: "o/r", tag: "v2.3" }],
  ])("refuses an invalid upstream.json %j", async (pin) => {
    const ws = workspace(pin);
    const r = await ws.run([]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unexpected repo, tag or commit/u);
  });

  test.each([
    [{ known: { "v2.2.0": "nope" } }],
    [{ known: 5 }],
    [{ known: [] }],
    [{ known: { "v2.2.0": ["a".repeat(40)] } }],
    [{ rejected: { v2: "a".repeat(40) } }],
  ])("refuses an invalid history in upstream.json %j", async (history) => {
    const ws = workspace({ ...DEFAULT_PIN, ...history });
    const r = await ws.run([]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unexpected "(?:known|rejected)"/u);
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
