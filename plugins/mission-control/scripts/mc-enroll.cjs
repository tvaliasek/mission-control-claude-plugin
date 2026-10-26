#!/usr/bin/env node
/*
 Enroll a Claude Code agent with Mission Control using an admin API key once,
 then hand the agent only an agent-scoped key.

 Usage:
   node mc-enroll.cjs --url https://mc.example.com --agent build-box [--print]

 Options:
   --url URL            Mission Control base URL (required)
   --agent NAME         Agent name to register (required)
   --key-name NAME      Label for the issued key (default: this hostname)
   --expires-days N     Key lifetime in days, 1-3650 (default: 90)
   --existing           Allow issuing a key for an agent that already exists
   --print              Print the agent key instead of configuring the local plugin

 The admin key is read from MC_ADMIN_API_KEY or prompted for without echo.
 It is never written anywhere. Without --print, the agent key is saved with
 `claude plugin configure mission-control@mission-control --values-stdin`.
*/

'use strict';

const os = require('node:os');
const { spawnSync } = require('node:child_process');

const PLUGIN_ID = 'mission-control@mission-control';
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;
// Printable ASCII only: anything else is rejected by fetch with an error that echoes the value
const KEY_RE = /^[\x21-\x7e]+$/;

function fail(message) {
  process.stderr.write(`mc-enroll: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { keyName: os.hostname(), expiresDays: 90, existing: false, print: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) fail(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '--url') opts.url = value();
    else if (arg === '--agent') opts.agent = value();
    else if (arg === '--key-name') opts.keyName = value();
    else if (arg === '--expires-days') opts.expiresDays = Number(value());
    else if (arg === '--existing') opts.existing = true;
    else if (arg === '--print') opts.print = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write('Usage: node mc-enroll.cjs --url URL --agent NAME [--key-name NAME] [--expires-days N] [--existing] [--print]\n');
      process.exit(0);
    } else fail(`unknown argument: ${arg}`);
  }
  if (!opts.url) fail('--url is required');
  // all-digit names are rejected because Mission Control resolves them as agent ids
  if (!opts.agent || !NAME_RE.test(opts.agent) || /^\d+$/.test(opts.agent)) {
    fail('--agent is required: 1-63 letters, digits, dots, hyphens or underscores, starting with a letter or digit, not only digits');
  }
  if (!Number.isInteger(opts.expiresDays) || opts.expiresDays < 1 || opts.expiresDays > 3650) {
    fail('--expires-days must be an integer between 1 and 3650');
  }
  opts.url = normalizeUrl(opts.url);
  return opts;
}

// Same rules as the bundled mc-base-url.cjs, inlined so this file can be downloaded on its own.
function normalizeUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch {
    fail('--url must be an absolute HTTP(S) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail('--url must use HTTP or HTTPS');
  if (parsed.username || parsed.password) fail('--url must not contain credentials');
  if (parsed.search || parsed.hash) fail('--url must not contain a query string or fragment');
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    process.stderr.write('mc-enroll: warning: plain HTTP sends the admin key unencrypted\n');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) fail('no terminal to prompt for the admin key; set MC_ADMIN_API_KEY instead');
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let input = '';
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeAllListeners('data');
      stdin.removeAllListeners('end');
      process.stderr.write('\n');
      resolve(input);
    };
    stdin.on('end', finish);
    stdin.on('data', (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') input = input.slice(0, -1);
        else input += ch;
      }
    });
  });
}

async function api(baseUrl, adminKey, method, route, body) {
  let res;
  try {
    res = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { 'x-api-key': adminKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      // following a redirect would send the admin key to the redirect target
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    // fetch error messages can contain header values, so report only the cause code
    fail(`${method} ${route} failed: ${err?.cause?.code || err?.name || 'network error'} (redirects are not followed)`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = {}; }
  return { status: res.status, ok: res.ok, data };
}

function checked(method, route, result) {
  if (!result.ok) fail(`${method} ${route} failed: HTTP ${result.status}${result.data.error ? ` ${result.data.error}` : ''}`);
  return result.data;
}

function configurePlugin(values) {
  const env = { ...process.env };
  delete env.MC_ADMIN_API_KEY;
  const result = spawnSync('claude', ['plugin', 'configure', PLUGIN_ID, '--values-stdin'], {
    input: JSON.stringify(values),
    stdio: ['pipe', 'inherit', 'inherit'],
    env,
  });
  if (result.error) return `could not run claude: ${result.error.code || result.error.message}`;
  if (result.status !== 0) return `claude plugin configure exited with ${result.status}`;
  return null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const adminKey = (process.env.MC_ADMIN_API_KEY || '').trim() || (await promptHidden('Mission Control admin API key: ')).trim();
  if (!adminKey) fail('admin API key is empty');
  if (!KEY_RE.test(adminKey)) fail('admin API key contains invalid characters');

  // look up first: registering an existing agent would reset its status to idle
  const agentRoute = `/api/agents/${encodeURIComponent(opts.agent)}`;
  const lookup = await api(opts.url, adminKey, 'GET', agentRoute);
  if (lookup.status !== 404) {
    checked('GET', agentRoute, lookup);
    if (!opts.existing) fail(`agent "${opts.agent}" already exists; pass --existing to issue it another key`);
  }

  const reg = checked('POST', '/api/agents/register', await api(opts.url, adminKey, 'POST', '/api/agents/register', {
    name: opts.agent,
    framework: 'claude-code',
  }));
  if (!reg.agent || reg.agent.id == null) fail('unexpected response from /api/agents/register');
  process.stderr.write(`mc-enroll: agent "${reg.agent.name}" ${reg.registered ? 'registered' : 'exists'} (id ${reg.agent.id})\n`);

  // operator is the lowest role that can connect, heartbeat, poll the queue and update tasks
  const keysRoute = `/api/agents/${reg.agent.id}/keys`;
  const issued = checked('POST', keysRoute, await api(opts.url, adminKey, 'POST', keysRoute, {
    name: opts.keyName,
    scopes: ['operator'],
    expires_in_days: opts.expiresDays,
  }));
  if (!issued.api_key) fail('unexpected response from the key endpoint');
  process.stderr.write(`mc-enroll: issued key ${issued.key?.key_prefix ?? ''}… (id ${issued.key?.id ?? '?'}), expires in ${opts.expiresDays} days\n`);

  if (opts.print) {
    process.stdout.write(`${issued.api_key}\n`);
    return;
  }

  const error = configurePlugin({ mc_url: opts.url, mc_api_key: issued.api_key, agent_name: opts.agent });
  if (error) {
    // The key exists server-side now; print it so it is not lost.
    process.stderr.write(`mc-enroll: ${error}\nmc-enroll: configure the plugin manually with this key:\n`);
    process.stdout.write(`${issued.api_key}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`mc-enroll: configured ${PLUGIN_ID}; start a new Claude Code session to use it\n`);
}

main().catch(() => fail('unexpected error'));
