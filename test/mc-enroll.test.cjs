'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'plugins', 'mission-control', 'scripts', 'mc-enroll.cjs');
const ADMIN_KEY = 'admin-test-key';

// Mock of the two Mission Control v2.3.0 endpoints the script calls.
function startServer(existingAgents = []) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], body });
      res.setHeader('Content-Type', 'application/json');
      if (req.headers['x-api-key'] !== ADMIN_KEY) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: 'Authentication required' }));
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

test('--print registers the agent and prints only the agent key', async () => {
  const srv = await startServer();
  try {
    const r = await run(['--url', srv.url, '--agent', 'build-box', '--key-name', 'ci', '--print']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'mca_agentkey\n');
    assert.ok(!r.stderr.includes(ADMIN_KEY));
    assert.deepEqual(srv.requests.map((q) => q.url), ['/api/agents/register', '/api/agents/7/keys']);
    assert.deepEqual(srv.requests[1].body, { name: 'ci', scopes: ['operator'], expires_in_days: 90 });
  } finally {
    srv.close();
  }
});

test('refuses an existing agent unless --existing is given', async () => {
  const srv = await startServer(['build-box']);
  try {
    const refused = await run(['--url', srv.url, '--agent', 'build-box', '--print']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /already exists/);
    assert.equal(srv.requests.length, 1, 'no key may be issued');

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

test('rejects invalid arguments before any request', async () => {
  for (const args of [
    ['--agent', 'x'],
    ['--url', 'ftp://mc.example.com', '--agent', 'x'],
    ['--url', 'https://u:p@mc.example.com', '--agent', 'x'],
    ['--url', 'https://mc.example.com', '--agent', '-bad'],
    ['--url', 'https://mc.example.com', '--agent', 'x', '--expires-days', '0'],
  ]) {
    const r = await run(args);
    assert.equal(r.code, 1, `expected failure for ${args.join(' ')}`);
  }
});
