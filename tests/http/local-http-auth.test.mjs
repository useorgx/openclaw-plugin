import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLocalHttpAuth } from '../../dist/local-http-auth.js';
import { createMcpHttpHandler } from '../../dist/mcp-http-handler.js';

test('local MCP requires credentials, blocks foreign browser origins and validates sessions', async () => {
  let calls = 0;
  let token = 'SYNTHETIC_GATEWAY_TOKEN';
  const authorize = createLocalHttpAuth(() => token);
  const mcp = createMcpHttpHandler({ serverName: 'security-test', serverVersion: '1', tools: new Map([
    ['synthetic', { name: 'synthetic', description: 'No side effects', parameters: {},
      execute: async () => { calls++; return { content: [{ type: 'text', text: 'ok' }] }; } }],
  ]) });
  const server = http.createServer(async (req, res) => {
    if (!authorize(req, res)) return;
    if (await mcp(req, res)) return;
    res.writeHead(200); res.end('ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'synthetic' } });
  const call = headers => new Promise((resolve, reject) => {
    const request = http.request(`${base}/orgx/mcp`, { method: 'POST', headers }, response => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode }));
    });
    request.on('error', reject);
    request.end(body);
  });
  try {
    assert.equal((await call({})).status, 401);
    assert.equal((await call({ authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await call({ origin: 'https://attacker.invalid', 'content-type': 'text/plain' })).status, 403);
    assert.equal((await call({ host: 'attacker.invalid', authorization: `Bearer ${token}` })).status, 403);
    assert.equal((await call({ authorization: `Bearer ${token}`, origin: `${base}0` })).status, 403);
    assert.equal(calls, 0);
    assert.equal((await call({ authorization: `Bearer ${token}` })).status, 200);
    assert.equal(calls, 1);
    const login = await fetch(`${base}/orgx/api/gateway-session`, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: base } });
    assert.equal(login.status, 204);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    assert.equal((await fetch(`${base}/orgx/api/live/stream`, { headers: { cookie: cookie.split(';')[0] } })).status, 200);
    token = 'SYNTHETIC_ROTATED_TOKEN';
    assert.equal((await call({ cookie: cookie.split(';')[0] })).status, 401);
    token = '';
    assert.equal((await call({})).status, 503);
    assert.equal(calls, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
