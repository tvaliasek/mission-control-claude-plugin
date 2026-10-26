/*
 Vendors the Mission Control MCP server into the plugin and re-applies our patch.

 Usage:
   node scripts/vendor-upstream.ts            re-vendor the tag in upstream.json
   node scripts/vendor-upstream.ts v2.4.0     vendor that tag
   node scripts/vendor-upstream.ts --latest   vendor the latest upstream release

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
const TAG_RE = /^v\d+\.\d+\.\d+$/u;
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
const bumpPluginPatchVersion = () => {
  const manifest = readFileSync(PLUGIN_JSON, "utf-8");
  const groups = VERSION_FIELD_RE.exec(manifest)?.groups;
  if (!groups) {
    throw new Error(`no MAJOR.MINOR.PATCH "version" in ${PLUGIN_JSON}`);
  }
  const next = `${groups.major}.${groups.minor}.${Number(groups.patch) + 1}`;
  writeFileSync(
    PLUGIN_JSON,
    manifest.replace(VERSION_FIELD_RE, `"version": "${next}"`)
  );
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

const main = async () => {
  const current = JSON.parse(readFileSync(UPSTREAM_JSON, "utf-8")) as Upstream;
  const tag = await resolveTag(process.argv[2], current);
  if (!TAG_RE.test(tag)) {
    throw new Error(`unexpected tag "${tag}"`);
  }
  const { sha } = (await github(
    `/repos/${current.repo}/commits/${encodeURIComponent(tag)}`
  )) as { sha: string };
  if (!SHA_RE.test(sha)) {
    throw new Error(`unexpected commit SHA for ${tag}`);
  }

  // download everything before writing, so a failed fetch leaves no mixed versions
  const contents = await Promise.all(
    Object.keys(FILES).map((from) => download(current.repo, sha, from))
  );
  const patched = Object.entries(FILES).map(([from, to], i) => {
    const content = contents[i] ?? "";
    return [to, from === PATCH.file ? applyPatch(content) : content] as const;
  });
  for (const [to, content] of patched) {
    writeFileSync(path.join(SCRIPTS_DIR, to), content);
  }

  const changed = tag !== current.tag || sha !== current.commit;
  if (changed) {
    writeFileSync(
      UPSTREAM_JSON,
      `${JSON.stringify({ ...current, commit: sha, tag }, null, 2)}\n`
    );
    bumpPluginPatchVersion();
  }
  process.stdout.write(
    `${changed ? "updated to" : "unchanged at"} ${current.repo}@${tag} (${sha})\n`
  );
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `changed=${changed}\ntag=${tag}\n`
    );
  }
};

await main();
