'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'plugins', 'mission-control', 'scripts', 'mc-enroll.cjs');
const ADMIN_KEY = 'admin-test-key';

// Mock of the Mission Control v2.3.0 endpoints the script calls.
function startServer({ existingAgents = [], handler } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], body });
      res.setHeader('Content-Type', 'application/json');
      if (handler && handler(req, res)) return;
      if (req.headers['x-api-key'] !== ADMIN_KEY) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: 'Authentication required' }));
      }
      const getMatch = req.method === 'GET' && req.url.match(/^\/api\/agents\/([^/]+)$/);
      if (getMatch) {
        const name = decodeURIComponent(getMatch[1]);
        res.statusCode = existingAgents.includes(name) ? 200 : 404;
        return res.end(JSON.stringify(existingAgents.includes(name) ? { agent: { id: 7, name } } : { error: 'Agent not found' }));
      }
      if (req.method === 'POST' && req.url === '/api/agents/register') {
        const exists = existingAgents.includes(body.name);
        res.statusCode = exists ? 200 : 201;
        return res.end(JSON.stringify({ agent: { id: 7, name: body.name }, registered: !exists }));
      }
      if (req.method === 'POST' && req.url === '/api/agents/7/keys') {
        res.statusCode = 201;
        return res.end(JSON.stringify({ key: { id: 3, key_prefix: 'mca_abcdef12' }, api_key: 'mca_agentkey' }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() });
  }));
}

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, MC_ADMIN_API_KEY: ADMIN_KEY, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// A fake `claude` on PATH that records its stdin, argv and whether it saw the admin key.
const tempDirs = [];
test.after(() => tempDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function fakeClaude(exitCode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-enroll-claude-'));
  tempDirs.push(dir);
  const out = path.join(dir, 'out.json');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}
let input = '';
process.stdin.on('data', (d) => { input += d; }).on('end', () => {
  require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({
    argv: process.argv.slice(2), input, sawAdminKey: 'MC_ADMIN_API_KEY' in process.env,
  }));
  process.exit(${exitCode});
});
`, { mode: 0o755 });
  return { PATH: `${dir}${path.delimiter}${process.env.PATH}`, read: () => JSON.parse(fs.readFileSync(out, 'utf8')) };
}

test('--print registers the agent and prints only the agent key', async () => {
  const srv = await startServer();
  try {
    const r = await run(['--url', srv.url, '--agent', 'build-box', '--key-name', 'ci', '--print']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'mca_agentkey\n');
    assert.ok(!r.stderr.includes(ADMIN_KEY));
    assert.deepEqual(srv.requests.map((q) => `${q.method} ${q.url}`), [
      'GET /api/agents/build-box', 'POST /api/agents/register', 'POST /api/agents/7/keys',
    ]);
    assert.deepEqual(srv.requests[2].body, { name: 'ci', scopes: ['operator'], expires_in_days: 90 });
  } finally {
    srv.close();
  }
});

test('refuses an existing agent without touching it unless --existing is given', async () => {
  const srv = await startServer({ existingAgents: ['build-box'] });
  try {
    const refused = await run(['--url', srv.url, '--agent', 'build-box', '--print']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /already exists/);
    assert.deepEqual(srv.requests.map((q) => q.method), ['GET'], 'only the read-only lookup may run');

    const allowed = await run(['--url', srv.url, '--agent', 'build-box', '--existing', '--print']);
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.equal(allowed.stdout, 'mca_agentkey\n');
  } finally {
    srv.close();
  }
});

test('reports an HTTP error without issuing a key', async () => {
  const srv = await startServer();
  try {
    const r = await run(['--url', srv.url, '--agent', 'build-box', '--print'], { MC_ADMIN_API_KEY: 'wrong' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /HTTP 401/);
    assert.equal(r.stdout, '');
  } finally {
    srv.close();
  }
});

test('does not follow redirects with the admin key', async () => {
  const other = await startServer();
  const srv = await startServer({
    handler: (req, res) => {
      res.statusCode = 307;
      res.setHeader('Location', `${other.url}${req.url}`);
      res.end();
      return true;
    },
  });
  try {
    const r = await run(['--url', srv.url, '--agent', 'build-box', '--print']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /redirects are not followed/);
    assert.equal(other.requests.length, 0);
  } finally {
    srv.close();
    other.close();
  }
});

test('rejects a key with control characters without echoing it', async () => {
  const srv = await startServer();
  try {
    const r = await run(['--url', srv.url, '--agent', 'build-box', '--print'], { MC_ADMIN_API_KEY: 'ab\u0004secret' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /invalid characters/);
    assert.ok(!r.stderr.includes('secret'));
    assert.equal(srv.requests.length, 0);
  } finally {
    srv.close();
  }
});

test('configures the plugin through claude without passing on the admin key', async () => {
  const srv = await startServer();
  const claude = fakeClaude(0);
  try {
    const r = await run(['--url', srv.url, '--agent', 'build-box'], { PATH: claude.PATH });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    const seen = claude.read();
    assert.deepEqual(seen.argv, ['plugin', 'configure', 'mission-control@mission-control', '--values-stdin']);
    assert.deepEqual(JSON.parse(seen.input), { mc_url: srv.url, mc_api_key: 'mca_agentkey', agent_name: 'build-box' });
    assert.equal(seen.sawAdminKey, false);
  } finally {
    srv.close();
  }
});

test('prints the issued key when configuring the plugin fails', async () => {
  const srv = await startServer();
  const claude = fakeClaude(3);
  try {
    const r = await run(['--url', srv.url, '--agent', 'build-box'], { PATH: claude.PATH });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /exited with 3/);
    assert.equal(r.stdout, 'mca_agentkey\n');
  } finally {
    srv.close();
  }
});

test('rejects invalid arguments before any request', async () => {
  for (const [args, message] of [
    [['--agent', 'x'], /--url is required/],
    [['--url', 'ftp://mc.example.com', '--agent', 'x'], /HTTP or HTTPS/],
    [['--url', 'https://u:p@mc.example.com', '--agent', 'x'], /credentials/],
    [['--url', 'https://mc.example.com', '--agent', '-bad'], /--agent is required/],
    [['--url', 'https://mc.example.com', '--agent', '123'], /--agent is required/],
    [['--url', 'https://mc.example.com', '--agent', 'x', '--expires-days', '0'], /--expires-days/],
  ]) {
    const r = await run(args);
    assert.equal(r.code, 1, `expected failure for ${args.join(' ')}`);
    assert.match(r.stderr, message);
  }
});
