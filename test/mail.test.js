'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { MailStore } = require('../server/coremx/store');
const { MailService } = require('../server/coremx/mail');
const { ActiveSync } = require('../server/coremx/activesync');
const w = require('../server/coremx/wbxml');
const n = w.node;
async function fixture(t) {
    const directory = await fs.mkdtemp(path.resolve('.cache/mail-'));
    const store = await new MailStore({ runDirectory: directory, kv: require('./helpers/kv')() }).open();
    t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
    const mail = new MailService(store); await store.transaction('domain', () => [{ collection: 'domains', id: 'domain', value: { name: 'example.test' } }]);
    const mailbox = await mail.createMailbox({ email: 'alice@example.test', owner: 'alice' });
    const credential = await mail.issueDevice(mailbox, 'phone');
    const authorization = 'Basic ' + Buffer.from(mailbox.email + ':' + credential.secret).toString('base64');
    const auth = await mail.authenticate(authorization, '127.0.0.1', 'phone1');
    return { store, mail, auth, authorization, eas: new ActiveSync(mail) };
}
test('device credentials are scoped, bound and revoked; plaintext secrets are not stored', async t => {
    const f = await fixture(t); assert.ok(f.auth);
    assert.equal(await f.mail.authenticate(f.authorization, '127.0.0.1', 'different'), null);
    assert.equal(f.store.list('devices')[0].secret, undefined);
    await f.mail.revokeDevice(f.auth.device.id);
    assert.equal(await f.mail.authenticate(f.authorization, '127.0.0.1', 'phone1'), null);
});
test('delivery is durable and idempotent; sync resumes, rejects foreign keys and returns email', async t => {
    const f = await fixture(t);
    const bytes = Buffer.from('From: sender@example.test\r\nTo: alice@example.test\r\nSubject: Test message\r\nMessage-ID: <unique@example.test>\r\n\r\nHello\r\n');
    await f.mail.deliver({ recipient: 'alice@example.test', bytes, deliveryId: 'queue-1' });
    await f.mail.deliver({ recipient: 'alice@example.test', bytes, deliveryId: 'queue-1' });
    assert.equal(f.store.forMailbox(f.auth.mailbox.id).list('messages').length, 1);
    const hierarchy = await f.eas.FolderSync(n('FolderHierarchy:FolderSync', n('FolderHierarchy:SyncKey', '0')), f.auth);
    assert.equal(w.value(hierarchy, 'FolderHierarchy:Status'), '1');
    const folder = f.store.forMailbox(f.auth.mailbox.id).list('folders', x => x.type === 2)[0];
    const request = key => n('AirSync:Sync', n('AirSync:Collections', n('AirSync:Collection', n('AirSync:SyncKey', key), n('AirSync:CollectionId', folder.id))));
    const run = async key => w.decode((await f.eas.execute('Sync', w.encode(request(key)), f.auth, new AbortController().signal)).body);
    const initial = await run('0'); const collection = w.child(w.child(initial, 'AirSync:Collections'), 'AirSync:Collection');
    const key = w.value(collection, 'AirSync:SyncKey'); assert.ok(key);
    const next = await run(key); assert.deepEqual(await run(key), next);
    const result = w.child(w.child(next, 'AirSync:Collections'), 'AirSync:Collection');
    const item = w.child(w.child(result, 'AirSync:Commands'), 'AirSync:Add');
    assert.equal(w.value(w.child(item, 'AirSync:ApplicationData'), 'Email:Subject'), 'Test message');
    const wrong = await run('not-a-valid-key'); assert.equal(w.value(w.child(w.child(wrong, 'AirSync:Collections'), 'AirSync:Collection'), 'AirSync:Status'), '3');
});
test('push request wakes after committed delivery', async t => {
    const f = await fixture(t); const inbox = f.store.forMailbox(f.auth.mailbox.id).list('folders', x => x.type === 2)[0];
    const pending = f.eas.Ping(n('Ping:Ping', n('Ping:HeartbeatInterval', '60'), n('Ping:Folders', n('Ping:Folder', n('Ping:Id', inbox.id), n('Ping:Class', 'Email')))), f.auth, new AbortController().signal);
    await f.mail.deliver({ recipient: 'alice@example.test', bytes: Buffer.from('Subject: Wake\r\n\r\nMessage'), deliveryId: 'queue-wake' });
    assert.equal(w.value(await pending, 'Ping:Status'), '2');
});
test('MIME submission checks sender, preserves bytes and deduplicates client retries', async t => {
    const f = await fixture(t);
    const raw = Buffer.from('From: alice@example.test\r\nTo: bob@example.test\r\nSubject: Outbound\r\n\r\nhello');
    await f.mail.submit(f.auth, raw, 'client-1'); await f.mail.submit(f.auth, raw, 'client-1');
    assert.equal(f.store.forMailbox(f.auth.mailbox.id).list('outbox').length, 1);
    const accepted = [];
    await f.mail.flushOutbox({ sendMail: async message => { accepted.push(message); return { accepted: ['bob@example.test'], rejected: [] }; } });
    assert.equal(accepted.length, 1); assert.deepEqual(accepted[0].raw, raw); assert.equal(f.store.forMailbox(f.auth.mailbox.id).list('outbox')[0].status, 'queued');
    await assert.rejects(f.mail.submit(f.auth, Buffer.from('From: victim@example.test\r\nTo: bob@example.test\r\n\r\nspoof'), 'client-2'), /Sender/);
});
test('WBXML accepts opaque MIME and rejects malformed lengths and nesting', () => {
    const root = n('ComposeMail:SendMail', n('ComposeMail:ClientId', 'abc'), n('ComposeMail:Mime', Buffer.from([0, 255, 128, 13, 10])));
    assert.deepEqual(w.decode(w.encode(root)), root);
    assert.throws(() => w.decode(Buffer.from([3, 1, 106, 0, 0x45])));
    assert.throws(() => w.decode(Buffer.from([3, 1, 106, 0, 0x45, 0xc3, 0xff, 0xff, 0xff, 0xff, 0xff])));
    assert.throws(() => w.decode(Buffer.from([3, 1, 106, 0, 0x85])));
});
test('contact application data synchronises to a second device without field loss', async t => {
    const f = await fixture(t); const folder = f.store.forMailbox(f.auth.mailbox.id).list('folders', x => x.type === 9)[0];
    const request = (key, commands) => n('AirSync:Sync', n('AirSync:Collections', n('AirSync:Collection', n('AirSync:SyncKey', key), n('AirSync:CollectionId', folder.id), commands)));
    const run = async (key, commands, auth = f.auth) => w.child(w.child(w.decode((await f.eas.execute('Sync', w.encode(request(key, commands)), auth, new AbortController().signal)).body), 'AirSync:Collections'), 'AirSync:Collection');
    const first = await run('0');
    const data = n('AirSync:ApplicationData', n('Contacts:FirstName', 'Alice'), n('Contacts:LastName', 'Example'), n('Contacts:Email1Address', 'alice@example.test'));
    const created = await run(w.value(first, 'AirSync:SyncKey'), n('AirSync:Commands', n('AirSync:Add', n('AirSync:ClientId', 'contact1'), data)));
    assert.equal(w.value(w.child(w.child(created, 'AirSync:Responses'), 'AirSync:Add'), 'AirSync:Status'), '1');
    const credential = await f.mail.issueDevice(f.auth.mailbox, 'second phone');
    const auth = await f.mail.authenticate('Basic ' + Buffer.from('alice@example.test:' + credential.secret).toString('base64'), '127.0.0.2', 'phone2');
    const second = await run('0', null, auth); const synced = await run(w.value(second, 'AirSync:SyncKey'), null, auth);
    assert.deepEqual(w.child(w.child(w.child(synced, 'AirSync:Commands'), 'AirSync:Add'), 'AirSync:ApplicationData'), data);
});
