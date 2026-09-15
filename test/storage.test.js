'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { MailStore, LIMIT } = require('../server/coremx/store');
const createKV = require('./helpers/kv');
const HEAD = 'coremx:v2:head';
const journal = sequence => 'coremx:v2:journal:' + sequence;
const chunkKey = (blob, index = 0) => `coremx:v2:blobs:${blob}:chunk:${index}`;
const manifestKey = blob => `coremx:v2:blobs:${blob}:manifest`;
const mutation = (id, subject = 'test') => [{ collection: 'testRecords', id, value: { subject } }];
async function fixture(t) {
    const directory = await fs.mkdtemp(path.resolve('.cache/store-'));
    let kv = createKV();
    let store = await new MailStore({ runDirectory: directory, kv }).open();
    t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
    return {
        directory, get kv() { return kv; }, get store() { return store; },
        async restart() {
            await store.close();
            // Reconstruct a client from ciphertext only, with no MailStore memory or disk state.
            kv = createKV({ backend: kv.backend, key: kv.gek });
            store = await new MailStore({ runDirectory: directory, kv }).open();
            return store;
        }
    };
}
test('encryptedkv alone restores mutations, binary blobs and retry deduplication', async t => {
    const f = await fixture(t); const content = crypto.randomBytes(700000); const blob = await f.store.putBlob(content);
    await Promise.all([1, 2, 3].map(n => f.store.transaction('op' + n, () => [{ collection: 'testRecords', id: 'm' + n, value: { blob, subject: 'private subject' } }])));
    await f.store.transaction('op1', () => { throw new Error('retry must not execute'); });
    assert.deepEqual(await fs.readdir(f.directory), ['coremx-writer.lock']);
    await f.store.close();
    assert.deepEqual(await fs.readdir(f.directory), []);
    await f.restart();
    assert.equal(f.store.sequence, 3);
    assert.equal(f.store.get('testRecords', 'm1').subject, 'private subject');
    assert.deepEqual(await f.store.getBlob(blob), content);
    await f.store.transaction('op1', () => { throw new Error('restart retry must not execute'); });
    for (const [key, ciphertext] of f.kv.backend) {
        assert.equal(key.includes('coremx'), false);
        assert.equal(ciphertext.includes('private subject'), false);
        assert.equal(ciphertext.includes(content.subarray(0, 100).toString('base64')), false);
    }
});
test('requires a KV client and excludes the plaintext server-side API', () => {
    assert.throws(() => new MailStore({ runDirectory: '/tmp' }), /encryptedkv client/);
    assert.throws(() => new MailStore({ runDirectory: '/tmp', kv: { get() {}, set() {}, ekvserver: true } }), /encryptedkv client/);
});
test('projection failure poisons writer and KV journal restores the whole transaction', async t => {
    const f = await fixture(t); const original = f.kv.set.bind(f.kv);
    f.kv.set = async (key, value) => {
        if (key.endsWith(':m2')) throw new Error('KV unavailable');
        return original(key, value);
    };
    await assert.rejects(f.store.transaction('op1', () => [...mutation('m1'), ...mutation('m2')]), /KV unavailable/);
    await assert.rejects(f.store.transaction('op2', () => []), /unavailable/);
    await f.restart();
    for (const id of ['m1', 'm2']) {
        assert.equal(f.store.get('testRecords', id).subject, 'test');
        assert.equal((await f.kv.get('coremx:v2:testRecords:' + id)).subject, 'test');
    }
});
test('failed commit before the head is written leaves no visible mutation after restart', async t => {
    const f = await fixture(t); await f.store.transaction('first', () => mutation('first'));
    const original = f.kv.set.bind(f.kv);
    f.kv.set = async (key, value) => { if (key === HEAD) throw new Error('head unavailable'); return original(key, value); };
    await assert.rejects(f.store.transaction('second', () => mutation('second')), /head unavailable/);
    await f.restart();
    assert.equal(f.store.get('testRecords', 'second'), null);
    assert.equal(f.store.sequence, 1);
    await f.store.transaction('second', () => mutation('second', 'retried'));
    await f.restart();
    assert.equal(f.store.get('testRecords', 'second').subject, 'retried');
});
test('lost acknowledgement after head persistence recovers the accepted transaction', async t => {
    const f = await fixture(t); const original = f.kv.set.bind(f.kv);
    f.kv.set = async (key, value) => { await original(key, value); if (key === HEAD) throw new Error('ack lost'); };
    await assert.rejects(f.store.transaction('op1', () => mutation('one')), /ack lost/);
    await f.restart();
    assert.equal(f.store.get('testRecords', 'one').subject, 'test');
    await f.store.transaction('op1', () => { throw new Error('must deduplicate'); });
});
test('startup does not rewrite historical projections', async t => {
    const f = await fixture(t);
    await f.store.transaction('one', () => mutation('one'));
    await f.store.transaction('two', () => mutation('two'));
    await f.store.close();
    const writes = []; const original = f.kv.set.bind(f.kv);
    f.kv.set = async (key, value) => { writes.push(key); return original(key, value); };
    const reopened = await new MailStore({ runDirectory: f.directory, kv: f.kv }).open();
    try { assert.deepEqual(writes, ['coremx:v2:testRecords:two']); }
    finally { await reopened.close(); }
});
test('substituted, incomplete and corrupt blob chunks fail validation', async t => {
    const f = await fixture(t); const a = await f.store.putBlob(Buffer.from([255, 1, 0])); const b = await f.store.putBlob(Buffer.from([3, 4]));
    await f.kv.set(chunkKey(b), await f.kv.get(chunkKey(a)));
    await assert.rejects(f.store.getBlob(b), /identity/);
    const chunk = await f.kv.get(chunkKey(a));
    await f.kv.set(chunkKey(a), { ...chunk, data: Buffer.from([0, 1, 0]).toString('base64') });
    await assert.rejects(f.store.getBlob(a), /integrity/);
    await f.kv.set(chunkKey(a), { ...chunk, data: 'AA==' });
    await assert.rejects(f.store.getBlob(a), /Invalid blob chunk/);
    await f.kv.del(chunkKey(a));
    await assert.rejects(f.store.getBlob(a), /identity/);
    await assert.rejects(f.store.getBlob('../outside'), /identifier/);
    await assert.rejects(f.store.getBlob('missing'), /manifest/);
});
test('encryptedkv rejects tampered ciphertext', async t => {
    const f = await fixture(t); const blob = await f.store.putBlob(Buffer.from('secret'));
    for (const [key, value] of f.kv.backend) {
        f.kv.backend.set(key, value.slice(0, -8) + 'AAAAAAAA');
    }
    await assert.rejects(f.store.getBlob(blob));
});
test('committed journal removal and substitution are detected on restart', async t => {
    const f = await fixture(t); await f.store.transaction('one', () => mutation('one'));
    const record = await f.kv.get(journal(1));
    await f.kv.del(journal(1));
    await assert.rejects(f.restart(), /truncated/);
    await f.kv.set(journal(1), { ...record, operation: 'substituted' });
    await assert.rejects(f.restart(), /integrity/);
});
test('incomplete chunk writes never publish a blob manifest and drain their batch', async t => {
    const f = await fixture(t); const original = f.kv.set.bind(f.kv); let active = 0; let peak = 0; let manifests = 0;
    f.kv.set = async (key, value) => {
        if (key.endsWith(':manifest')) manifests++;
        active++; peak = Math.max(peak, active);
        try {
            await new Promise(resolve => setImmediate(resolve));
            if (key.endsWith(':chunk:1')) throw new Error('chunk unavailable');
            await original(key, value);
        } finally { active--; }
    };
    await assert.rejects(f.store.putBlob(crypto.randomBytes(2 * 1024 * 1024)), /chunk unavailable/);
    assert.equal(active, 0); assert.equal(manifests, 0); assert.equal(peak, 4);
});
test('blob boundaries, bounded I/O and binary round trips through the actual KV codec', async t => {
    const f = await fixture(t); let active = 0; let peak = 0;
    for (const method of ['set', 'get']) {
        const original = f.kv[method].bind(f.kv);
        f.kv[method] = async (...args) => {
            active++; peak = Math.max(peak, active);
            try { return await original(...args); } finally { active--; }
        };
    }
    for (const size of [0, 1, 256 * 1024, 256 * 1024 + 1, LIMIT]) {
        const content = crypto.randomBytes(size); const blob = await f.store.putBlob(content);
        assert.equal((await f.kv.get(manifestKey(blob))).chunks, Math.ceil(size / (256 * 1024)));
        assert.deepEqual(await f.store.getBlob(blob), content);
    }
    assert.equal(peak, 4);
    await assert.rejects(f.store.putBlob(Buffer.alloc(LIMIT + 1)), /size limit/);
});
test('each mailbox has one independent collection; predicates and IDs remain local', async t => {
    const f = await fixture(t); const a = f.store.forMailbox('alice'); const b = f.store.forMailbox('bob');
    await a.transaction('a', () => [{ collection: 'messages', id: 'same', value: { folder: 'inbox', subject: 'Alice' } }, { collection: 'folders', id: 'inbox', value: { name: 'Inbox' } }]);
    await b.transaction('b', () => [{ collection: 'messages', id: 'same', value: { folder: 'inbox', subject: 'Bob' } }]);
    const visited = [];
    assert.equal(a.list('messages', item => { visited.push(item.subject); return true; })[0].id, 'same');
    assert.deepEqual(visited, ['Alice']); assert.equal(b.get('messages', 'same').subject, 'Bob');
    assert.equal(f.store.list('messages').length, 0);
    assert.equal(f.store.list('mailbox_alice').length, 2); assert.equal(f.store.list('mailbox_bob').length, 1);
    await assert.rejects(a.transaction('foreign', () => [{ collection: 'messages', id: 'bad', value: { mailbox: 'bob' } }]), /outside mailbox/);
    assert.throws(() => a.list('mailboxes'), /record type/);
    await f.restart(); assert.equal(f.store.forMailbox('alice').get('messages', 'same').subject, 'Alice');
});
test('runtime lock rejects another local writer and close waits for pending blob writes', async t => {
    const f = await fixture(t);
    await assert.rejects(new MailStore({ runDirectory: f.directory, kv: f.kv }).open(), /already running/);
    const pending = f.store.putBlob(crypto.randomBytes(700000));
    await f.store.close();
    const blob = await pending;
    assert.deepEqual(await fs.readdir(f.directory), []);
    await assert.rejects(f.store.putBlob(Buffer.from('closed')), /unavailable/);
    await f.restart(); assert.equal((await f.store.getBlob(blob)).length, 700000);
});
