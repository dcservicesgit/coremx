'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./helpers/mail');
const { node: n, child, children, value, encode, decode } = require('../server/coremx/wbxml');
const key = root => value(root, 'AirSync:SyncKey');
const opts = filter => n('AirSync:Options', n('AirSync:FilterType', String(filter)));
const updates = root => child(root, 'AirSync:Commands')?.children || [];
const folder = (f, type = 2) => f.scope.list('folders', item => item.type === type)[0];
const estimate = async (f, box, token, options) => {
    const result = await f.execute('GetItemEstimate', n('GetItemEstimate:GetItemEstimate', n('GetItemEstimate:Collections', n('GetItemEstimate:Collection', n('AirSync:SyncKey', token), n('GetItemEstimate:CollectionId', box.id), options))));
    return child(result, 'GetItemEstimate:Response');
};

test('filtered Sync, pagination, SoftDelete and estimates use the same mailbox-local delta', async t => {
    const f = await fixture(t); const inbox = folder(f);
    const old = await f.deliver('Old', new Date(Date.now() - 10 * 86400000));
    await f.deliver('Recent'); await f.deliver('Recent 2');
    const initial = await f.sync(inbox); assert.equal(updates(initial).length, 0);
    const first = await f.sync(inbox, key(initial), n('AirSync:WindowSize', '1'));
    assert.equal(updates(first).length, 1); assert.ok(child(first, 'AirSync:MoreAvailable'));
    assert.equal(value(child(await estimate(f, inbox, key(first)), 'GetItemEstimate:Collection'), 'GetItemEstimate:Estimate'), '2');
    const all = await f.sync(inbox, key(first)); assert.equal(updates(all).length, 2);
    const filtered = await f.sync(inbox, key(all), opts(1));
    assert.equal(updates(filtered).length, 1); assert.equal(updates(filtered)[0].name, 'AirSync:SoftDelete');
    assert.equal(value(updates(filtered)[0], 'AirSync:ServerId'), old.id);
    assert.equal(value(child(await estimate(f, inbox, key(filtered)), 'GetItemEstimate:Collection'), 'GetItemEstimate:Estimate'), '0');
    assert.equal(value(await estimate(f, inbox, '0'), 'GetItemEstimate:Status'), '3');
    assert.equal(value(await estimate(f, inbox, 'foreign-key'), 'GetItemEstimate:Status'), '4');
    assert.equal(value(await f.sync(inbox, key(filtered), opts(8)), 'AirSync:Status'), '4');
    const restored = await f.sync(inbox, key(filtered), opts(0)); assert.equal(updates(restored)[0].name, 'AirSync:Add');
});

test('body preferences preserve UTF-8, persist between requests and support full message fetch', async t => {
    const f = await fixture(t); const inbox = folder(f); const message = await f.deliver('Body', new Date(), 'ééé hello');
    const options = n('AirSync:Options', n('AirSyncBase:BodyPreference', n('AirSyncBase:Type', '1'), n('AirSyncBase:TruncationSize', '3'), n('AirSyncBase:Preview', '4')));
    const initial = await f.sync(inbox, '0', options); const synced = await f.sync(inbox, key(initial));
    const body = child(child(updates(synced)[0], 'AirSync:ApplicationData'), 'AirSyncBase:Body');
    assert.equal(value(body, 'AirSyncBase:Data'), 'é'); assert.equal(value(body, 'AirSyncBase:Truncated'), '1'); assert.equal(value(body, 'AirSyncBase:Preview'), 'ééé ');
    const fetched = await f.execute('ItemOperations', n('ItemOperations:ItemOperations', n('ItemOperations:Fetch', n('ItemOperations:Store', 'Mailbox'), n('AirSync:CollectionId', inbox.id), n('AirSync:ServerId', message.id), n('ItemOperations:Options', n('AirSyncBase:BodyPreference', n('AirSyncBase:Type', '1')), n('ItemOperations:Schema', n('AirSyncBase:Body'))))));
    const properties = child(child(child(fetched, 'ItemOperations:Response'), 'ItemOperations:Fetch'), 'ItemOperations:Properties');
    assert.equal(properties.children.length, 1); assert.equal(value(child(properties, 'AirSyncBase:Body'), 'AirSyncBase:Data'), 'ééé hello');
});

test('Sync commits mutations and retry responses atomically and respects conflicts and GetChanges', async t => {
    const f = await fixture(t); const inbox = folder(f); const message = await f.deliver('Read me');
    const initial = await f.sync(inbox); const synced = await f.sync(inbox, key(initial));
    const other = await f.device(f.box, 'second');
    const secondInitial = await f.sync(inbox, '0', [], other); const secondSynced = await f.sync(inbox, key(secondInitial), [], other);
    const change = n('AirSync:Commands', n('AirSync:Change', n('AirSync:ServerId', message.id), n('AirSync:ApplicationData', n('Email:Read', '1'))));
    const changed = await f.sync(inbox, key(synced), [change, n('AirSync:GetChanges', '0')]);
    assert.equal(updates(changed).length, 0); assert.equal(f.scope.get('messages', message.id).read, true);
    assert.equal(f.scope.get('messages', message.id).revision, f.scope.get('sync', key(changed)).revision);
    await f.restart(); assert.deepEqual(await f.sync(inbox, key(synced), [change, n('AirSync:GetChanges', '0')]), changed);
    const conflict = await f.sync(inbox, key(secondSynced), change, other);
    assert.equal(value(child(child(conflict, 'AirSync:Responses'), 'AirSync:Change'), 'AirSync:Status'), '7');
    const pending = await f.deliver('Pending');
    const noDownload = await f.sync(inbox, key(changed), n('AirSync:GetChanges', '0')); assert.equal(updates(noDownload).length, 0);
    const downloaded = await f.sync(inbox, key(noDownload)); assert.equal(value(updates(downloaded)[0], 'AirSync:ServerId'), pending.id);
    const remove = [n('AirSync:DeletesAsMoves', '0'), n('AirSync:Commands', n('AirSync:Delete', n('AirSync:ServerId', message.id)))];
    const before = f.store.get('mailboxes', f.box.id).usedBytes;
    const deleted = await f.sync(inbox, key(downloaded), remove); assert.equal(f.scope.get('messages', message.id), null);
    assert.equal(f.store.get('mailboxes', f.box.id).usedBytes, before - message.size);
    assert.deepEqual(await f.sync(inbox, key(downloaded), remove), deleted); assert.equal(f.store.get('mailboxes', f.box.id).usedBytes, before - message.size);
});

test('Supported contact fields preserve ghosted values while clearing omitted managed fields', async t => {
    const f = await fixture(t); const contacts = folder(f, 9);
    const initial = await f.sync(contacts, '0', n('AirSync:Supported', n('Contacts:FirstName'), n('Contacts:LastName')));
    const added = await f.sync(contacts, key(initial), n('AirSync:Commands', n('AirSync:Add', n('AirSync:ClientId', 'new-contact'), n('AirSync:ApplicationData', n('Contacts:FirstName', 'Alice'), n('Contacts:LastName', 'Example'), n('Contacts:Email1Address', 'alice@example.test')))));
    const id = value(child(child(added, 'AirSync:Responses'), 'AirSync:Add'), 'AirSync:ServerId');
    const changed = await f.sync(contacts, key(added), n('AirSync:Commands', n('AirSync:Change', n('AirSync:ServerId', id), n('AirSync:ApplicationData', n('Contacts:FirstName', 'Alicia')))));
    assert.equal(value(child(child(changed, 'AirSync:Responses'), 'AirSync:Change'), 'AirSync:Status'), '1');
    const data = n('AirSync:ApplicationData', f.scope.get('messages', id).applicationData);
    assert.equal(value(data, 'Contacts:FirstName'), 'Alicia'); assert.equal(value(data, 'Contacts:Email1Address'), 'alice@example.test'); assert.equal(child(data, 'Contacts:LastName'), undefined);
});

test('mailbox boundaries apply to Sync keys, folder IDs, fetch and estimates', async t => {
    const f = await fixture(t); const inbox = folder(f); const message = await f.deliver('Private');
    const initial = await f.sync(inbox);
    const bob = await f.mail.createMailbox({ email: 'bob@example.test', owner: 'bob' }); const other = await f.device(bob, 'bobphone');
    const bobInbox = f.store.forMailbox(bob.id).list('folders', item => item.type === 2)[0];
    const denied = await f.sync(bobInbox, key(initial), [], other); assert.equal(value(denied, 'AirSync:Status'), '3');
    assert.equal(value(await f.sync(inbox, '0', [], other), 'AirSync:Status'), '12');
    const result = await f.execute('ItemOperations', n('ItemOperations:ItemOperations', n('ItemOperations:Fetch', n('ItemOperations:Store', 'Mailbox'), n('AirSync:CollectionId', inbox.id), n('AirSync:ServerId', message.id))), other);
    assert.equal(value(child(child(result, 'ItemOperations:Response'), 'ItemOperations:Fetch'), 'ItemOperations:Status'), '150');
    assert.equal(f.store.forMailbox(bob.id).list('messages').length, 0);
});

test('Ping wakes on source moves and deletions, ignores other mailboxes, and cleans up cancellation', { timeout: 10000 }, async t => {
    const f = await fixture(t); const inbox = folder(f); const trash = folder(f, 4); const message = await f.deliver('Move me');
    const initial = await f.sync(inbox); const synced = await f.sync(inbox, key(initial));
    const startPing = (signal = new AbortController().signal) => f.eas.Ping(n('Ping:Ping', n('Ping:HeartbeatInterval', '60'), n('Ping:Folders', n('Ping:Folder', n('Ping:Id', inbox.id), n('Ping:Class', 'Email')))), f.auth, signal);
    let pending = startPing();
    const move = (from, to) => f.execute('MoveItems', n('Move:MoveItems', n('Move:Move', n('Move:SrcMsgId', message.id), n('Move:SrcFldId', from.id), n('Move:DstFldId', to.id))));
    assert.equal(value(child(await move(inbox, trash), 'Move:Response'), 'Move:Status'), '3');
    assert.equal(value(await pending, 'Ping:Status'), '2');
    // Immediate retries succeed, and a later identical move after a return move executes.
    await move(inbox, trash); await move(trash, inbox); await move(inbox, trash);
    assert.equal(f.scope.get('messages', message.id).folder, trash.id);
    await move(trash, inbox);
    const current = await f.sync(inbox, key(synced));
    pending = startPing();
    await f.scope.transaction('server-delete', () => [{ collection: 'messages', id: message.id, value: null }]);
    assert.equal(value(await pending, 'Ping:Status'), '2');
    const deleted = await f.sync(inbox, key(current)); assert.equal(updates(deleted)[0].name, 'AirSync:Delete');
    const bob = await f.mail.createMailbox({ email: 'bob@example.test', owner: 'bob' });
    const abort = new AbortController(); const baseline = f.store.listenerCount('change');
    let settled = false; pending = startPing(abort.signal); pending.then(() => { settled = true; }, () => { settled = true; });
    await f.deliver('Bob only', new Date(), 'private', bob.email);
    assert.equal(settled, false); abort.abort(); await assert.rejects(pending, /cancelled/);
    assert.equal(f.store.listenerCount('change'), baseline); assert.equal(f.eas.pings.size, 0);
});

test('attachment inline and multipart responses preserve binary data and report per-fetch errors', async t => {
    const f = await fixture(t); const content = Buffer.from([0, 255, 128, 13, 10, 42]);
    const raw = Buffer.from('From: sender@example.test\r\nTo: alice@example.test\r\nSubject: File\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nMessage\r\n--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="sample.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + content.toString('base64') + '\r\n--b--\r\n');
    await f.mail.deliver({ recipient: f.box.email, bytes: raw, deliveryId: 'binary' });
    const message = f.scope.list('messages')[0];
    const fetch = reference => n('ItemOperations:Fetch', n('ItemOperations:Store', 'Mailbox'), n('AirSyncBase:FileReference', reference));
    const root = n('ItemOperations:ItemOperations', fetch(message.id + ':0'), fetch(message.id + ':999'));
    const inline = await f.execute('ItemOperations', root); const results = children(child(inline, 'ItemOperations:Response'), 'ItemOperations:Fetch');
    assert.deepEqual(Buffer.from(value(child(results[0], 'ItemOperations:Properties'), 'ItemOperations:Data'), 'base64'), content);
    assert.equal(value(results[1], 'ItemOperations:Status'), '15');
    const multipart = await f.eas.execute('ItemOperations', encode(root), f.auth, new AbortController().signal, { multipart: true });
    assert.equal(new Map(multipart.headers).get('content-type'), 'application/vnd.ms-sync.multipart');
    const bytes = multipart.body; assert.equal(bytes.readUInt32LE(0), 2);
    assert.equal(bytes.readUInt32LE(4), 20);
    const wbxmlOffset = bytes.readUInt32LE(4); const wbxmlLength = bytes.readUInt32LE(8);
    const bodyOffset = bytes.readUInt32LE(12); const bodyLength = bytes.readUInt32LE(16);
    assert.equal(bodyOffset, wbxmlOffset + wbxmlLength); assert.equal(bodyOffset + bodyLength, bytes.length);
    const decoded = decode(bytes.subarray(wbxmlOffset, bodyOffset));
    const properties = child(child(child(decoded, 'ItemOperations:Response'), 'ItemOperations:Fetch'), 'ItemOperations:Properties');
    assert.equal(value(properties, 'ItemOperations:Part'), '1'); assert.deepEqual(bytes.subarray(bodyOffset), content);
    const inbox = folder(f);
    const mimeRequest = n('ItemOperations:ItemOperations', n('ItemOperations:Fetch', n('ItemOperations:Store', 'Mailbox'), n('AirSync:CollectionId', inbox.id), n('AirSync:ServerId', message.id), n('ItemOperations:Options', n('AirSync:MIMESupport', '2'), n('AirSyncBase:BodyPreference', n('AirSyncBase:Type', '4')))));
    const mime = await f.execute('ItemOperations', mimeRequest);
    const body = child(child(child(child(mime, 'ItemOperations:Response'), 'ItemOperations:Fetch'), 'ItemOperations:Properties'), 'AirSyncBase:Body');
    assert.equal(value(body, 'AirSyncBase:Type'), '4'); assert.deepEqual(child(body, 'AirSyncBase:Data').children[0], raw);
});

test('folder creation retries, custom contact folders and cycle prevention preserve hierarchy', async t => {
    const f = await fixture(t);
    const hierarchy = await f.execute('FolderSync', n('FolderHierarchy:FolderSync', n('FolderHierarchy:SyncKey', '0')));
    const create = (syncKey, name, parent = '0', type = 12) => n('FolderHierarchy:FolderCreate', n('FolderHierarchy:SyncKey', syncKey), n('FolderHierarchy:ParentId', parent), n('FolderHierarchy:DisplayName', name), n('FolderHierarchy:Type', String(type)));
    const request = create(value(hierarchy, 'FolderHierarchy:SyncKey'), 'Friends', '0', 14);
    const parent = await f.execute('FolderCreate', request); assert.deepEqual(await f.execute('FolderCreate', request), parent);
    const parentId = value(parent, 'FolderHierarchy:ServerId'); assert.equal(f.scope.get('folders', parentId).type, 14);
    assert.equal(value(await f.sync(f.scope.get('folders', parentId)), 'AirSync:Status'), '1');
    const sub = await f.execute('FolderCreate', create(value(parent, 'FolderHierarchy:SyncKey'), 'Child', parentId));
    const subId = value(sub, 'FolderHierarchy:ServerId');
    const rejected = await f.execute('FolderUpdate', n('FolderHierarchy:FolderUpdate', n('FolderHierarchy:SyncKey', value(sub, 'FolderHierarchy:SyncKey')), n('FolderHierarchy:ServerId', parentId), n('FolderHierarchy:ParentId', subId), n('FolderHierarchy:DisplayName', 'Friends')));
    assert.equal(value(rejected, 'FolderHierarchy:Status'), '5'); assert.equal(f.scope.get('folders', parentId).parent, '0');
    await f.restart(); assert.deepEqual(await f.execute('FolderCreate', request), parent);
});

test('HTML all-or-none falls back to requested plain body and Settings persist device metadata', async t => {
    const f = await fixture(t); const inbox = folder(f);
    await f.mail.deliver({ recipient: f.box.email, deliveryId: 'html', bytes: Buffer.from('Subject: HTML\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello world</p>') });
    const options = n('AirSync:Options', n('AirSyncBase:BodyPreference', n('AirSyncBase:Type', '2'), n('AirSyncBase:TruncationSize', '2'), n('AirSyncBase:AllOrNone', '1')), n('AirSyncBase:BodyPreference', n('AirSyncBase:Type', '1'), n('AirSyncBase:TruncationSize', '5')));
    const initial = await f.sync(inbox, '0', options); const result = await f.sync(inbox, key(initial));
    const body = child(child(updates(result)[0], 'AirSync:ApplicationData'), 'AirSyncBase:Body');
    assert.equal(value(body, 'AirSyncBase:Type'), '1'); assert.equal(value(body, 'AirSyncBase:Data'), 'Hello');
    await f.execute('Settings', n('Settings:Settings', n('Settings:DeviceInformation', n('Settings:Set', n('Settings:Model', 'Test phone'), n('Settings:OS', 'Test OS')))));
    await f.restart(); const information = n('Settings:Set', f.store.get('devices', f.auth.device.id).information);
    assert.equal(value(information, 'Settings:Model'), 'Test phone');
});
