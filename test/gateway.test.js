'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { startHttpWorker } = require('../server/coremx/central')('modules/httpWorker');
const binary = process.env.CENTRALFW_TEST_BINARY || path.resolve('.cache/cargo/debug/centralfw');
function call(port, { body = '', host = 'mail.test', url = '/', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: url, method: 'POST', headers: { host, ...headers } }, res => {
            const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); res.on('error', reject);
        }); req.on('error', reject); req.end(body);
    });
}
test('CentralFW HTTP bridge streams bytes, preserves headers and fails closed without workers', { timeout: 15000 }, async t => {
    await fs.access(binary);
    const directory = await fs.mkdtemp(path.resolve('.cache/gateway-'));
    const port = 31000 + crypto.randomInt(10000); const socketPath = path.join(directory, 'http.sock');
    const child = spawn(binary, [], { env: { ...process.env, CENTRALFW_BIND_ADDR: `127.0.0.1:${port}`, CENTRALFW_WORKER_SOCKET: path.join(directory, 'ws.sock'), CENTRALFW_HTTP_WORKER_SOCKET: socketPath, CENTRALFW_HTTP_HOSTS: 'mail.test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let worker; let stderr = ''; child.stderr.on('data', b => { stderr += b; });
    t.after(async () => { worker?.close(); if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); } await fs.rm(directory, { recursive: true, force: true }); });
    await new Promise((resolve, reject) => { child.stdout.on('data', b => { if (b.toString().includes('WebSocket server')) resolve(); }); child.once('exit', () => reject(new Error('gateway failed to start: ' + stderr))); });
    assert.equal((await call(port)).status, 503);
    assert.equal((await call(port, { host: 'attacker.test' })).status, 421);
    worker = startHttpWorker({ socketPath, handler: async request => {
        const chunks = []; for await (const c of request.body) chunks.push(c);
        return { status: 201, headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2']], body: Buffer.concat(chunks) };
    } });
    let result;
    for (let i = 0; i < 50; i++) { result = await call(port); if (result.status !== 503) break; await new Promise(r => setTimeout(r, 10)); }
    assert.equal(result.status, 201);
    const bytes = crypto.randomBytes(300000);
    result = await call(port, { body: bytes });
    assert.equal(result.status, 201); assert.deepEqual(result.body, bytes); assert.deepEqual(result.headers['set-cookie'], ['a=1', 'b=2']);
    worker.close();
    let entered, cancelled;
    const started = new Promise(resolve => { entered = resolve; });
    const aborted = new Promise(resolve => { cancelled = resolve; });
    worker = startHttpWorker({ socketPath, handler: async request => {
        for await (const chunk of request.body) { /* consume */ }
        if (request.target === '/hold') {
            entered();
            await new Promise(resolve => request.signal.addEventListener('abort', () => { cancelled(); resolve(); }, { once: true }));
        }
        return { status: 200, body: '' };
    } });
    for (let i = 0; i < 50; i++) { if ((await call(port)).status === 200) break; await new Promise(r => setTimeout(r, 10)); }
    const held = http.request({ host: '127.0.0.1', port, path: '/hold', method: 'POST', headers: { host: 'mail.test' } });
    held.on('error', () => {}); held.end(); await started; held.destroy();
    await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error('Client cancellation did not reach worker')), 1500).unref())]);
    worker.close();
    for (let i = 0; i < 50; i++) { result = await call(port); if (result.status === 503) break; await new Promise(r => setTimeout(r, 10)); }
    assert.equal(result.status, 503);

});
