/*
 Vendors the Mission Control MCP server into the plugin and re-applies our patch.

 Usage:
   node scripts/vendor-upstream.ts            re-vendor the tag in upstream.json
   node scripts/vendor-upstream.ts v2.4.0     vendor that tag
   node scripts/vendor-upstream.ts --latest   vendor the latest upstream release,
                                              unless it is older than the vendored one
   node scripts/vendor-upstream.ts v2.3.0 --accept-moved
                                              vendor that tag even though the vendored
                                              tag moved or vanished upstream (refused
                                              otherwise): take the moved tag, or roll back

 Files are fetched at the tag's commit SHA. When the tag changes, upstream.json is
 updated and the plugin's patch version is bumped, so installed plugins update.
 Set GITHUB_TOKEN to avoid the GitHub API's anonymous rate limit.
*/

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const UPSTREAM_JSON = path.join(ROOT, "upstream.json");
const PLUGIN_JSON = path.join(
  ROOT,
  "plugins/mission-control/.claude-plugin/plugin.json"
);
const SCRIPTS_DIR = path.join(ROOT, "plugins/mission-control/scripts");
const SHA_RE = /^[0-9a-f]{40}$/u;
const REPO_RE = /^[\w-]+\/[\w.-]+$/u;
// no leading zeros: v02.3.0 must not pass as a release other than v2.3.0
const TAG_RE = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const VERSION_FIELD_RE =
  /"version": "(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)"/u;

// upstream path -> vendored file name
const FILES: Record<string, string> = {
  LICENSE: "LICENSE.mission-control",
  "scripts/mc-base-url.cjs": "mc-base-url.cjs",
  "scripts/mc-mcp-server.cjs": "mc-mcp-server.cjs",
};

// With MC_URL set (always, under the plugin) ignore the mc-cli profile: its session
// cookie is checked before the API key and would be sent to the configured URL.
const PATCH = {
  file: "scripts/mc-mcp-server.cjs",
  find: `  let profile = {};
  try {
    profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));`,
  replace: `  let profile = {};
  // mission-control-claude-plugin patch: with MC_URL set, ignore the CLI profile so a saved
  // session cookie can't override the configured API key or leak to another host
  if (!process.env.MC_URL) try {
    profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));`,
};

interface Upstream {
  repo: string;
  tag: string;
  commit: string;
}

const github = async (route: string): Promise<unknown> => {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(`https://api.github.com${route}`, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${route}: HTTP ${res.status}`);
  }
  return res.json();
};

const download = async (
  repo: string,
  commit: string,
  file: string
): Promise<string> => {
  const url = `https://raw.githubusercontent.com/${repo}/${commit}/${file}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  return res.text();
};

const applyPatch = (source: string): string => {
  const parts = source.split(PATCH.find);
  if (parts.length !== 2) {
    throw new Error(
      `patch anchor found ${parts.length - 1} times in ${PATCH.file}; upstream changed loadConfig, update PATCH in scripts/vendor-upstream.ts`
    );
  }
  return parts.join(PATCH.replace);
};

// Edits only the version string so the manifest keeps its formatting.
const bumpPatchVersion = (manifest: string): string => {
  const groups = VERSION_FIELD_RE.exec(manifest)?.groups;
  if (!groups) {
    throw new Error(`no MAJOR.MINOR.PATCH "version" in ${PLUGIN_JSON}`);
  }
  const next = `${groups.major}.${groups.minor}.${Number(groups.patch) + 1}`;
  return manifest.replace(VERSION_FIELD_RE, `"version": "${next}"`);
};

const versionOf = (tag: string) => tag.slice(1).split(".").map(Number);

// true when tag a is an older release than tag b (both match TAG_RE)
const isOlder = (a: string, b: string) => {
  const [x, y] = [versionOf(a), versionOf(b)];
  const i = x.findIndex((n, k) => n !== y[k]);
  return i !== -1 && (x[i] ?? 0) < (y[i] ?? 0);
};

const writeOutputs = (changed: boolean, tag: string, sha: string) => {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `changed=${changed}\ntag=${tag}\ncommit=${sha}\n`
    );
  }
};

const resolveTag = async (arg: string | undefined, current: Upstream) => {
  if (arg === "--latest") {
    const release = (await github(
      `/repos/${current.repo}/releases/latest`
    )) as { tag_name: string };
    return release.tag_name;
  }
  return arg ?? current.tag;
};

const commitOf = async (repo: string, tag: string): Promise<string> => {
  const { sha } = (await github(
    `/repos/${repo}/commits/${encodeURIComponent(tag)}`
  )) as { sha: string };
  if (!SHA_RE.test(sha)) {
    throw new Error(`unexpected commit SHA for ${tag}`);
  }
  return sha;
};

// Only as "<tag> --accept-moved": the workflow passes one argument, so it can't accept
// a moved tag; that is for a person who checked upstream.
const parseArgs = (args: string[]) => {
  const acceptMoved = args[1] === "--accept-moved";
  const valid = acceptMoved
    ? args.length === 2 && TAG_RE.test(args[0] ?? "")
    : args.length <= 1;
  if (!valid) {
    throw new Error(
      "usage: vendor-upstream.ts [<tag> [--accept-moved] | --latest]"
    );
  }
  return { acceptMoved, arg: args[0] };
};

const readPinned = (): Upstream => {
  const current = JSON.parse(readFileSync(UPSTREAM_JSON, "utf-8")) as Upstream;
  if (
    !(
      REPO_RE.test(current.repo) &&
      TAG_RE.test(current.tag) &&
      SHA_RE.test(current.commit)
    )
  ) {
    throw new Error(`unexpected repo, tag or commit in ${UPSTREAM_JSON}`);
  }
  return current;
};

const NOT_FOUND_RE = /HTTP (?:404|422)$/u;

// A vendored tag that upstream moved to another commit, or removed, is a possible
// upstream compromise: refuse to go on until someone checks and takes a tag on
// purpose with --accept-moved. Returns the vendored tag's current commit.
const checkVendoredTag = async (current: Upstream): Promise<string> => {
  const way =
    `check upstream, then take it with: npm run vendor -- ${current.tag} --accept-moved` +
    ", or roll back with: npm run vendor -- <older tag> --accept-moved";
  let sha: string;
  try {
    sha = await commitOf(current.repo, current.tag);
  } catch (error) {
    if (error instanceof Error && NOT_FOUND_RE.test(error.message)) {
      throw new Error(
        `the vendored ${current.tag} no longer exists upstream; ${way}`,
        { cause: error }
      );
    }
    throw error;
  }
  if (sha !== current.commit) {
    throw new Error(
      `upstream moved ${current.tag} from ${current.commit} to ${sha}; ${way}`
    );
  }
  return sha;
};

const main = async () => {
  const { acceptMoved, arg } = parseArgs(process.argv.slice(2));
  const current = readPinned();
  const tag = await resolveTag(arg, current);
  if (!TAG_RE.test(tag)) {
    throw new Error(`unexpected tag "${tag}"`);
  }
  // skipped for a newer release, which replaces the vendored tag, and for a tag a
  // person took explicitly with --accept-moved (the moved one, or a rollback)
  const vendoredSha =
    isOlder(current.tag, tag) || acceptMoved
      ? undefined
      : await checkVendoredTag(current);
  // the latest release can go back (newest one deleted, an older one marked latest):
  // keep what is vendored instead of opening a downgrade
  if (arg === "--latest" && isOlder(tag, current.tag)) {
    process.stdout.write(
      `latest release ${tag} is older than the vendored ${current.tag}; unchanged\n`
    );
    writeOutputs(false, current.tag, current.commit);
    return;
  }
  const sha =
    tag === current.tag && vendoredSha
      ? vendoredSha
      : await commitOf(current.repo, tag);

  // compute every output before writing any, so a failure leaves no mixed state
  const contents = await Promise.all(
    Object.keys(FILES).map((from) => download(current.repo, sha, from))
  );
  const outputs: [string, string][] = Object.entries(FILES).map(
    ([from, to], i) => {
      const content = contents[i] ?? "";
      return [
        path.join(SCRIPTS_DIR, to),
        from === PATCH.file ? applyPatch(content) : content,
      ];
    }
  );
  const changed = tag !== current.tag || sha !== current.commit;
  if (changed) {
    outputs.push(
      [
        UPSTREAM_JSON,
        `${JSON.stringify({ ...current, commit: sha, tag }, null, 2)}\n`,
      ],
      [PLUGIN_JSON, bumpPatchVersion(readFileSync(PLUGIN_JSON, "utf-8"))]
    );
  }
  for (const [file, content] of outputs) {
    writeFileSync(file, content);
  }
  process.stdout.write(
    `${changed ? "updated to" : "unchanged at"} ${current.repo}@${tag} (${sha})\n`
  );
  writeOutputs(changed, tag, sha);
};

await main();
