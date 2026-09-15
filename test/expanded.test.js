'use strict';
const test = require('node:test'),
    assert = require('node:assert/strict');
const fixture = require('./helpers/mail');
const { node: n, child, children, value, encode, decode } = require('../server/coremx/wbxml');
const { compose } = require('../server/coremx/mime');
const codec = require('../server/coremx/calendar-codec');
const { Webmail } = require('../server/coremx/webmail');
const f = (name, text) => n(name, String(text));
const event = () => ({
    uid: require('node:crypto').randomUUID(),
    subject: 'Weekly design review',
    start: '2026-03-22T09:00:00.000Z',
    end: '2026-03-22T10:00:00.000Z',
    timeZone: 'Europe/London',
    rrule: 'FREQ=WEEKLY;BYDAY=SU;COUNT=3',
    attendees: [{ email: 'bob@example.test', status: 'NEEDS-ACTION' }],
    organizer: { email: 'alice@example.test' },
    sequence: 0,
    exceptions: [],
    busy: 2,
    body: 'Design together'
});
test('recurrence preserves London local time across DST and round trips ICS and EAS', () => {
    const e = event(),
        rows = codec.occurrences(e, '2026-03-01T00:00:00Z', '2026-04-30T00:00:00Z');
    assert.deepEqual(
        rows.map((r) => r.start),
        ['2026-03-22T09:00:00.000Z', '2026-03-29T08:00:00.000Z', '2026-04-05T08:00:00.000Z']
    );
    const parsed = codec.parseICS(codec.toICS(e)).event;
    assert.deepEqual(
        codec
            .occurrences({ ...parsed, ics: undefined }, '2026-03-01T00:00:00Z', '2026-04-30T00:00:00Z')
            .map((r) => r.start),
        rows.map((r) => r.start)
    );
    const eas = codec.fromEas(codec.toEas(e, '16.1'), undefined, '16.1');
    assert.deepEqual(
        codec.occurrences(eas, '2026-03-01T00:00:00Z', '2026-04-30T00:00:00Z').map((r) => r.start),
        rows.map((r) => r.start)
    );
    assert.throws(() => codec.validate({ ...e, end: e.start }));
    assert.throws(() => codec.validate({ ...e, rrule: 'FREQ=WEEKLY;COUNT=0;INTERVAL=0' }));
});
test('SmartReply and SmartForward quote MIME, forward attachments, deduplicate, and isolate sources', async (t) => {
    const x = await fixture(t);
    const raw = await compose({
        from: 'bob@example.test',
        to: x.box.email,
        subject: 'Original',
        text: 'Original body',
        attachments: [{ filename: 'a.txt', content: Buffer.from('original attachment') }]
    });
    await x.mail.deliver({ recipient: x.box.email, deliveryId: 'original', bytes: raw });
    const m = x.scope.list('messages', (m) => !!m.blob)[0];
    for (const command of ['SmartReply', 'SmartForward']) {
        const draft = await compose({
            from: x.box.email,
            to: 'bob@example.test',
            subject: 'Reply',
            text: 'New body'
        });
        const root = n(
            'ComposeMail:' + command,
            f('ComposeMail:ClientId', command),
            n('ComposeMail:SaveInSentItems'),
            n('ComposeMail:Source', f('ComposeMail:FolderId', m.folder), f('ComposeMail:ItemId', m.id)),
            n('ComposeMail:Mime', draft)
        );
        const out = await x.eas.execute(command, encode(root), x.auth);
        assert.equal(out.body.length, 0);
        await x.eas.execute(command, encode(root), x.auth);
        const queued = x.scope.list('outbox').at(-1);
        const parsed = await x.mail.parse(await x.store.getBlob(queued.blob));
        assert.match(parsed.text, /New body/);
        assert.match(parsed.text, /Original body/);
        assert.equal(parsed.attachments.length, command === 'SmartForward' ? 1 : 0);
    }
    assert.equal(x.scope.list('outbox').length, 2);
    assert.equal(x.scope.get('messages', m.id).lastVerb, 3);
    const other = await x.mail.createMailbox({ email: 'eve@example.test', owner: 'eve' }),
        auth = await x.device(other, 'eve');
    const denied = await x.execute(
        'SmartReply',
        n('ComposeMail:SmartReply', n('ComposeMail:Source', f('ComposeMail:LongId', m.id))),
        auth
    );
    assert.equal(value(denied, 'ComposeMail:Status'), '150');
});
test('invitation request, attendee reply, organizer update, removal and cancellation are durable', async (t) => {
    const x = await fixture(t),
        bob = await x.mail.createMailbox({ email: 'bob@example.test', owner: 'bob' }),
        bobAuth = await x.device(bob, 'bob');
    const saved = await x.mail.calendar.save(x.auth, { ...event(), clientId: 'invite' });
    assert.ok(saved.calendar);
    assert.equal(x.scope.list('outbox').length, 1);
    let count = 0;
    const deliver = async (box) => {
        const scope = x.store.forMailbox(box.id);
        for (const q of scope.list('outbox', (q) => q.status === 'pending')) {
            const bytes = await x.store.getBlob(q.blob);
            for (const recipient of q.recipients)
                await x.mail.deliver({ recipient, bytes, deliveryId: 'cal' + ++count });
            await scope.transaction('sent' + count, () => [
                { collection: 'outbox', id: q.id, value: { ...q, status: 'queued' } }
            ]);
        }
    };
    await deliver(x.box);
    const bobScope = x.store.forMailbox(bob.id),
        invitation = bobScope.list('messages', (m) => !!m.meeting)[0];
    assert.ok(invitation);
    assert.equal(bobScope.list('messages', (m) => !!m.calendar).length, 1);
    const reply = n(
        'MeetingResponse:MeetingResponse',
        n(
            'MeetingResponse:Request',
            f('MeetingResponse:RequestId', invitation.id),
            f('MeetingResponse:CollectionId', invitation.folder),
            f('MeetingResponse:UserResponse', 1),
            n('MeetingResponse:SendResponse')
        )
    );
    const response = await x.execute('MeetingResponse', reply, bobAuth, undefined, { version: '16.1' });
    assert.equal(value(child(response, 'MeetingResponse:Result'), 'MeetingResponse:Status'), '1');
    await deliver(bob);
    assert.equal(x.scope.get('messages', saved.id).calendar.attendees[0].status, 'ACCEPTED');
    const current = x.scope.get('messages', saved.id);
    await x.mail.calendar.cancel(x.auth, current.id, current.revision);
    await deliver(x.box);
    assert.equal(bobScope.list('messages', (m) => !!m.calendar)[0].calendar.status, 'CANCELLED');
    await x.restart();
    assert.equal(
        x.store.forMailbox(bob.id).list('messages', (m) => !!m.calendar)[0].calendar.status,
        'CANCELLED'
    );
});
test('policy gates data, requires full acknowledgement, renews and wipes only the account', async (t) => {
    const x = await fixture(t);
    const request = n(
        'Provision:Provision',
        n('Provision:Policies', n('Provision:Policy', f('Provision:PolicyType', 'MS-EAS-Provisioning-WBXML')))
    );
    const options = { version: '16.1', enforcePolicy: true, policyKey: '0' };
    const hierarchy = n('FolderHierarchy:FolderSync', f('FolderHierarchy:SyncKey', 0));
    let response = await x.execute('FolderSync', hierarchy, x.auth, undefined, options);
    assert.equal(value(response, 'FolderHierarchy:Status'), '142');
    response = await x.execute('Provision', request, x.auth, undefined, options);
    const policy = child(child(response, 'Provision:Policies'), 'Provision:Policy'),
        key = value(policy, 'Provision:PolicyKey');
    assert.ok(key);
    assert.equal(
        value(
            child(child(policy, 'Provision:Data'), 'Provision:EASProvisionDoc'),
            'Provision:DevicePasswordEnabled'
        ),
        '1'
    );
    const ack = n(
        'Provision:Provision',
        n(
            'Provision:Policies',
            n(
                'Provision:Policy',
                f('Provision:PolicyType', 'MS-EAS-Provisioning-WBXML'),
                f('Provision:PolicyKey', key),
                f('Provision:Status', 1)
            )
        )
    );
    response = await x.execute('Provision', ack, x.auth, undefined, options);
    const final = value(
        child(child(response, 'Provision:Policies'), 'Provision:Policy'),
        'Provision:PolicyKey'
    );
    assert.notEqual(final, key);
    options.policyKey = final;
    response = await x.execute('FolderSync', hierarchy, x.auth, undefined, options);
    assert.equal(value(response, 'FolderHierarchy:Status'), '1');
    await x.store.transaction('version', (s) => [
        {
            collection: 'devices',
            id: x.auth.device.id,
            value: { ...s.get('devices', x.auth.device.id), protocolVersion: '16.1' }
        }
    ]);
    await x.mail.policy.requestWipe(x.auth.device.id, 'alice');
    response = await x.execute('FolderSync', hierarchy, x.auth, undefined, options);
    assert.equal(value(response, 'FolderHierarchy:Status'), '140');
    response = await x.execute('Provision', request, x.auth, undefined, options);
    assert.ok(child(response, 'Provision:AccountOnlyRemoteWipe'));
    assert.equal(child(response, 'Provision:RemoteWipe'), undefined);
    await x.execute(
        'Provision',
        n('Provision:Provision', n('Provision:AccountOnlyRemoteWipe', f('Provision:Status', 1))),
        x.auth,
        undefined,
        options
    );
    assert.equal(x.store.get('devices', x.auth.device.id).revoked, true);
    assert.equal(x.store.get('mailboxes', x.box.id).enabled, true);
});
test('webmail drafts, chunked attachments, sanitization, retry-safe send and mailbox isolation', async (t) => {
    const x = await fixture(t),
        web = new Webmail(x.mail, { ...x.auth, device: { id: 'web:alice' } });
    const upload = await web.upload({
        index: 0,
        filename: 'note.txt',
        base64: Buffer.from('hello').toString('base64')
    });
    let draft = await web.draft({
        subject: 'A draft',
        text: 'Draft body',
        to: 'bob@example.test',
        attachments: [{ upload: upload.id }]
    });
    assert.equal(draft.attachments.length, 1);
    assert.equal(
        (await web.attachment({ id: draft.id, index: 0 })).base64,
        Buffer.from('hello').toString('base64')
    );
    draft = await web.draft({
        ...draft,
        subject: 'Updated',
        attachments: draft.attachments.map((a) => ({ ...a, message: draft.id }))
    });
    assert.equal((await web.list({})).items[0].subject, 'Updated');
    const sending = {
        ...draft,
        clientId: 'send-once',
        attachments: draft.attachments.map((a) => ({ ...a, message: draft.id }))
    };
    await web.send(sending);
    await web.send(sending);
    assert.equal(x.scope.list('outbox').length, 1);
    assert.equal(x.scope.get('messages', draft.id), null);
    const raw = await compose({
        from: 'bob@example.test',
        to: x.box.email,
        subject: 'HTML',
        html: '<script>alert(1)</script><img src="https://tracker.example/pixel"><a href="javascript:alert(1)">bad</a><b>Safe</b>'
    });
    await x.mail.deliver({ recipient: x.box.email, deliveryId: 'html', bytes: raw });
    const m = x.scope.list('messages', (m) => !!m.blob)[0],
        read = await web.read({ id: m.id });
    assert.ok(read.html.includes('<b>Safe</b>'));
    assert.doesNotMatch(read.html, /script|https:\/\/tracker|javascript:/i);
    const box = await x.mail.createMailbox({ email: 'eve@example.test', owner: 'eve' }),
        other = new Webmail(x.mail, { mailbox: box, device: { id: 'eve' } });
    await assert.rejects(other.read({ id: m.id }), /unavailable/);
    await assert.rejects(
        other.compose({ subject: 'Steal', text: '', attachments: [{ upload: upload.id }] }),
        /expired/
    );
});
test('Search, Find, GAL and recipient resolution return scoped results', async (t) => {
    const x = await fixture(t);
    await x.deliver('Budget review', new Date(), 'Secret project');
    const box = await x.mail.createMailbox({ email: 'bob@example.test', owner: 'bob' });
    await x.deliver('Budget elsewhere', new Date(), 'Other secret', box.email);
    const root = n(
        'Search:Search',
        n(
            'Search:Store',
            f('Search:Name', 'Mailbox'),
            n('Search:Query', n('Search:And', f('AirSync:Class', 'Email'), f('Search:FreeText', 'Budget'))),
            n('Search:Options', f('Search:Range', '0-9'))
        )
    );
    const response = await x.execute('Search', root);
    const store = child(child(response, 'Search:Response'), 'Search:Store');
    assert.equal(value(store, 'Search:Total'), '1');
    const resolve = await x.execute(
        'ResolveRecipients',
        n('ResolveRecipients:ResolveRecipients', f('ResolveRecipients:To', 'bob@example.test'))
    );
    assert.equal(value(child(resolve, 'ResolveRecipients:Response'), 'ResolveRecipients:Status'), '1');
    const find = await x.execute(
        'Find',
        n(
            'Find:Find',
            f('Find:SearchId', require('node:crypto').randomUUID()),
            n(
                'Find:ExecuteSearch',
                n(
                    'Find:MailBoxSearchCriterion',
                    n('Find:Query', f('AirSync:Class', 'Email'), f('Find:FreeText', 'subject: Budget'))
                )
            )
        ),
        x.auth,
        undefined,
        { version: '16.1' }
    );
    assert.equal(value(child(find, 'Find:Response'), 'Find:Total'), '1');
});
test('16.1 drafts sync, saved empty Sync, Partial and hanging Sync wake on delivery', async (t) => {
    const x = await fixture(t),
        auth = { ...x.auth, protocolVersion: '16.1' },
        drafts = x.scope.list('folders', (f) => f.type === 3)[0],
        inbox = x.scope.list('folders', (f) => f.type === 2)[0];
    let state = await x.sync(drafts, '0', [], auth),
        key = value(state, 'AirSync:SyncKey');
    assert.ok(key);
    state = await x.sync(
        drafts,
        key,
        [
            n(
                'AirSync:Commands',
                n(
                    'AirSync:Add',
                    f('AirSync:ClientId', 'draft1'),
                    n(
                        'AirSync:ApplicationData',
                        f('Email:To', 'bob@example.test'),
                        f('Email:Subject', 'Phone draft'),
                        f('Email2:IsDraft', 1),
                        n('AirSyncBase:Body', f('AirSyncBase:Type', 1), f('AirSyncBase:Data', 'Phone body'))
                    )
                )
            )
        ],
        auth
    );
    assert.equal(value(child(child(state, 'AirSync:Responses'), 'AirSync:Add'), 'AirSync:Status'), '1');
    assert.ok(x.scope.list('messages', (m) => m.draft)[0]);
    state = await x.sync(inbox, '0', [], auth);
    key = value(state, 'AirSync:SyncKey');
    const root = n(
        'AirSync:Sync',
        f('AirSync:HeartbeatInterval', 60),
        n(
            'AirSync:Collections',
            n('AirSync:Collection', f('AirSync:CollectionId', inbox.id), f('AirSync:SyncKey', key))
        )
    );
    const pending = x.eas.execute('Sync', encode(root), auth, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 20));
    await x.deliver('Push');
    const response = decode((await pending).body);
    assert.ok(child(child(child(response, 'AirSync:Collections'), 'AirSync:Collection'), 'AirSync:Commands'));
    const controller = new AbortController();
    controller.abort();
    const empty = await x.eas.execute('Sync', Buffer.alloc(0), auth, controller.signal);
    assert.ok(empty.body.length);
});
test('16.1 attachment IDs survive deletion and draft sending preserves quota and item identity', async (t) => {
    const x = await fixture(t),
        auth = { ...x.auth, protocolVersion: '16.1' },
        folder = x.scope.list('folders', (f) => f.type === 3)[0];
    let state = await x.sync(folder, '0', [], auth);
    const file = (id, text) =>
        n(
            'AirSyncBase:Add',
            f('AirSyncBase:ClientId', id),
            f('AirSyncBase:Method', 1),
            f('AirSyncBase:DisplayName', id + '.txt'),
            f('AirSyncBase:ContentType', 'text/plain'),
            n('AirSyncBase:Content', Buffer.from(text))
        );
    state = await x.sync(
        folder,
        value(state, 'AirSync:SyncKey'),
        [
            n(
                'AirSync:Commands',
                n(
                    'AirSync:Add',
                    f('AirSync:ClientId', 'withfiles'),
                    n(
                        'AirSync:ApplicationData',
                        f('Email:To', 'bob@example.test'),
                        f('Email:Subject', 'Attached'),
                        f('Email2:IsDraft', 1),
                        n('AirSyncBase:Body', f('AirSyncBase:Type', 1), f('AirSyncBase:Data', 'body')),
                        n('AirSyncBase:Attachments', file('a', 'first'), file('b', 'second'))
                    )
                )
            )
        ],
        auth
    );
    const added = child(child(state, 'AirSync:Responses'), 'AirSync:Add');
    assert.equal(value(added, 'AirSync:Status'), '1');
    const id = value(added, 'AirSync:ServerId');
    const refs = children(
        child(child(added, 'AirSync:ApplicationData'), 'AirSyncBase:Attachments'),
        'AirSyncBase:Attachment'
    ).map((a) => value(a, 'AirSyncBase:FileReference'));
    assert.equal(refs.length, 2);
    state = await x.sync(
        folder,
        value(state, 'AirSync:SyncKey'),
        [
            n(
                'AirSync:Commands',
                n(
                    'AirSync:Change',
                    f('AirSync:ServerId', id),
                    n(
                        'AirSync:ApplicationData',
                        n(
                            'AirSyncBase:Attachments',
                            n('AirSyncBase:Delete', f('AirSyncBase:FileReference', refs[0]))
                        )
                    )
                )
            )
        ],
        auth
    );
    const fetch = n(
        'ItemOperations:ItemOperations',
        n(
            'ItemOperations:Fetch',
            f('ItemOperations:Store', 'Mailbox'),
            f('AirSyncBase:FileReference', refs[1])
        )
    );
    let result = await x.execute('ItemOperations', fetch, auth);
    assert.equal(
        value(
            child(
                child(child(result, 'ItemOperations:Response'), 'ItemOperations:Fetch'),
                'ItemOperations:Properties'
            ),
            'ItemOperations:Data'
        ),
        Buffer.from('second').toString('base64')
    );
    state = await x.sync(
        folder,
        value(state, 'AirSync:SyncKey'),
        [
            n(
                'AirSync:Commands',
                n(
                    'AirSync:Change',
                    f('AirSync:ServerId', id),
                    n('Email2:Send'),
                    n('AirSync:ApplicationData', f('Email2:IsDraft', 1))
                )
            )
        ],
        auth
    );
    assert.equal(x.scope.list('outbox', (o) => o.status === 'pending').length, 1);
    const bytes = x.store.get('mailboxes', x.box.id).usedBytes;
    await x.mail.flushOutbox({ sendMail: async () => ({ accepted: ['bob@example.test'], rejected: [] }) });
    assert.equal(x.store.get('mailboxes', x.box.id).usedBytes, bytes);
    assert.equal(x.scope.get('messages', id).folder, x.scope.list('folders', (f) => f.type === 5)[0].id);
    result = await x.execute('ItemOperations', fetch, auth);
    assert.equal(
        value(
            child(child(result, 'ItemOperations:Response'), 'ItemOperations:Fetch'),
            'ItemOperations:Status'
        ),
        '1'
    );
});
test('calendar Sync creates invitations and single-instance deletion sends cancellation without deleting the series', async (t) => {
    const x = await fixture(t),
        auth = { ...x.auth, protocolVersion: '16.1' },
        folder = x.scope.list('folders', (f) => f.type === 8)[0];
    let state = await x.sync(folder, '0', [], auth);
    const e = event();
    state = await x.sync(
        folder,
        value(state, 'AirSync:SyncKey'),
        [
            n(
                'AirSync:Commands',
                n(
                    'AirSync:Add',
                    f('AirSync:ClientId', 'calendar1'),
                    n('AirSync:ApplicationData', codec.toEas(e, '16.1'))
                )
            )
        ],
        auth
    );
    const added = child(child(state, 'AirSync:Responses'), 'AirSync:Add'),
        id = value(added, 'AirSync:ServerId');
    assert.equal(value(added, 'AirSync:Status'), '1');
    assert.equal(x.scope.list('outbox').length, 1);
    state = await x.sync(
        folder,
        value(state, 'AirSync:SyncKey'),
        [
            n(
                'AirSync:Commands',
                n(
                    'AirSync:Delete',
                    f('AirSync:ServerId', id),
                    f('AirSyncBase:InstanceId', '2026-03-29T08:00:00.000Z')
                )
            )
        ],
        auth
    );
    assert.ok(x.scope.get('messages', id));
    assert.equal(x.scope.get('messages', id).calendar.exceptions[0].deleted, true);
    assert.equal(x.scope.list('outbox').length, 2);
    const parsed = await x.mail.parse(await x.store.getBlob(x.scope.list('outbox').at(-1).blob));
    const ics = parsed.attachments.find((a) => a.contentType === 'text/calendar').content.toString();
    assert.match(ics, /METHOD:CANCEL/);
    assert.match(ics, /RECURRENCE-ID/);
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
});
test('timezone gaps, overlaps, southern DST, recurrence exceptions and class schemas reject invalid inputs', () => {
    const tz = require('../server/coremx/timezone');
    assert.equal(
        new Date(tz.fromWall('2026-03-08T02:30:00', 'America/New_York')).toISOString(),
        '2026-03-08T07:30:00.000Z'
    );
    assert.equal(
        new Date(tz.fromWall('2026-11-01T01:30:00', 'America/New_York')).toISOString(),
        '2026-11-01T05:30:00.000Z'
    );
    const zone = tz.encodeZone('Australia/Sydney', Date.parse('2026-01-01T00:00:00Z'));
    assert.equal(tz.offsetAt(Date.parse('2026-01-15T00:00:00Z'), undefined, zone), 11 * 3600000);
    assert.equal(tz.offsetAt(Date.parse('2026-07-15T00:00:00Z'), undefined, zone), 10 * 3600000);
    assert.throws(() => tz.decodeZone(Buffer.alloc(171).toString('base64')));
    const e = event();
    assert.throws(() =>
        codec.validate({ ...e, exceptions: [{ instance: '2026-03-30T08:00:00.000Z', deleted: true }] })
    );
    const rows = codec.occurrences(
        {
            ...e,
            exceptions: [
                {
                    instance: '2026-04-05T08:00:00.000Z',
                    start: '2026-03-24T09:00:00.000Z',
                    end: '2026-03-24T10:00:00.000Z'
                }
            ]
        },
        '2026-03-24T00:00:00Z',
        '2026-03-25T00:00:00Z'
    );
    assert.equal(rows.length, 1);
    assert.throws(() =>
        require('../server/coremx/classes').validate('Contacts', [
            n('Contacts:FirstName', n('Tasks:Subject', 'injected'))
        ])
    );
    assert.throws(() =>
        require('../server/coremx/classes').validate('Calendar', [
            ...codec.toEas(e),
            n('Calendar:Attendees', n('Calendar:Attendee', f('Calendar:Email', 'bad')))
        ])
    );
});
test('query expressions, policy expiry/partial acknowledgement and malformed protocol requests fail correctly', async (t) => {
    const x = await fixture(t);
    await x.deliver('Budget review', new Date(), 'Project Alpha');
    await x.deliver('Budget draft', new Date(), 'Project Beta');
    assert.equal(
        (await x.mail.search.mailbox(x.auth, { query: 'subject:Budget AND (Alpha OR Gamma) NOT Beta' }))
            .total,
        1
    );
    await assert.rejects(x.mail.search.mailbox(x.auth, { query: 'unknown:value' }), /Unsupported/);
    const bad = await x.eas.execute('Sync', Buffer.from([3, 1, 106, 0, 0xff]), x.auth);
    assert.equal(value(decode(bad.body), 'AirSync:Status'), '102');
    const unsupported = await x.eas.execute('Find', encode(n('Find:Find')), x.auth, undefined, {
        version: '16.0'
    });
    assert.equal(value(decode(unsupported.body), 'Find:Status'), '138');
    const request = n(
        'Provision:Provision',
        n('Provision:Policies', n('Provision:Policy', f('Provision:PolicyType', 'MS-EAS-Provisioning-WBXML')))
    );
    let r = await x.execute('Provision', request);
    const key = value(child(child(r, 'Provision:Policies'), 'Provision:Policy'), 'Provision:PolicyKey');
    r = await x.execute(
        'Provision',
        n(
            'Provision:Provision',
            n(
                'Provision:Policies',
                n(
                    'Provision:Policy',
                    f('Provision:PolicyType', 'MS-EAS-Provisioning-WBXML'),
                    f('Provision:PolicyKey', key),
                    f('Provision:Status', 2)
                )
            )
        )
    );
    assert.equal(value(child(child(r, 'Provision:Policies'), 'Provision:Policy'), 'Provision:Status'), '4');
    assert.equal(x.mail.policy.check(x.auth, '0', '16.1'), 142);
    const protocol = require('../server/coremx/protocol');
    const packed = Buffer.concat([
        Buffer.from([161, 19, 9, 4, 5]),
        Buffer.from('phone'),
        Buffer.from([4]),
        Buffer.from([0x78, 0x56, 0x34, 0x12, 4]),
        Buffer.from('Test'),
        Buffer.from([7, 1, 2])
    ]).toString('base64');
    assert.deepEqual(protocol.query(new URL('https://mail.test/Microsoft-Server-ActiveSync?' + packed)), {
        version: '16.1',
        command: 'ItemOperations',
        deviceId: 'phone',
        deviceType: 'Test',
        policyKey: '305419896',
        multipart: true
    });
    assert.throws(() => protocol.query(new URL('https://mail.test/?AA==')));
});
test('conversation filtering, HTML body parts, MIME truncation and attachment ranges', async (t) => {
    const x = await fixture(t),
        folder = x.scope.list('folders', (f) => f.type === 2)[0];
    const old = await compose({
        from: 'bob@example.test',
        to: x.box.email,
        subject: 'Conversation',
        text: 'Original paragraph',
        messageId: '<parent@example.test>',
        date: new Date(Date.now() - 40 * 86400000),
        attachments: [{ filename: 'numbers.txt', content: Buffer.from('0123456789') }]
    });
    await x.mail.deliver({ recipient: x.box.email, bytes: old, deliveryId: 'parent' });
    const recent = await compose({
        from: 'bob@example.test',
        to: x.box.email,
        subject: 'Re: Conversation',
        text: 'New paragraph\n\n> Original paragraph',
        messageId: '<child@example.test>',
        inReplyTo: '<parent@example.test>',
        references: ['<parent@example.test>']
    });
    await x.mail.deliver({ recipient: x.box.email, bytes: recent, deliveryId: 'child' });
    let state = await x.sync(folder, '0', [
        f('AirSync:ConversationMode', 1),
        n(
            'AirSync:Options',
            f('AirSync:FilterType', 1),
            n('AirSyncBase:BodyPreference', f('AirSyncBase:Type', 1), f('AirSyncBase:Preview', 40))
        )
    ]);
    state = await x.sync(folder, value(state, 'AirSync:SyncKey'));
    const commands = children(child(state, 'AirSync:Commands'), 'AirSync:Add');
    assert.equal(commands.length, 2);
    assert.equal(
        commands.filter(
            (c) =>
                value(child(child(c, 'AirSync:ApplicationData'), 'AirSyncBase:Body'), 'AirSyncBase:Data') ===
                ''
        ).length,
        1
    );
    const childItem = x.scope.list('messages', (m) => m.messageId === '<child@example.test>')[0];
    let result = await x.execute(
        'ItemOperations',
        n(
            'ItemOperations:ItemOperations',
            n(
                'ItemOperations:Fetch',
                f('ItemOperations:Store', 'Mailbox'),
                f('AirSync:CollectionId', folder.id),
                f('AirSync:ServerId', childItem.id),
                n('ItemOperations:Options', n('AirSyncBase:BodyPartPreference', f('AirSyncBase:Type', 2)))
            )
        )
    );
    let props = child(
        child(child(result, 'ItemOperations:Response'), 'ItemOperations:Fetch'),
        'ItemOperations:Properties'
    );
    assert.match(value(child(props, 'AirSyncBase:BodyPart'), 'AirSyncBase:Data'), /New paragraph/);
    assert.doesNotMatch(
        value(child(props, 'AirSyncBase:BodyPart'), 'AirSyncBase:Data'),
        /Original paragraph/
    );
    const parent = x.scope.list('messages', (m) => m.messageId === '<parent@example.test>')[0];
    result = await x.execute(
        'ItemOperations',
        n(
            'ItemOperations:ItemOperations',
            n(
                'ItemOperations:Fetch',
                f('ItemOperations:Store', 'Mailbox'),
                f('AirSyncBase:FileReference', parent.id + ':0'),
                n('ItemOperations:Options', f('ItemOperations:Range', '3-6'))
            )
        )
    );
    props = child(
        child(child(result, 'ItemOperations:Response'), 'ItemOperations:Fetch'),
        'ItemOperations:Properties'
    );
    assert.equal(value(props, 'ItemOperations:Data'), Buffer.from('3456').toString('base64'));
    assert.equal(value(props, 'ItemOperations:Total'), '10');
});
test('declining an invitation removes the live calendar item and permits a later acceptance', async (t) => {
    const x = await fixture(t),
        e = {
            ...event(),
            organizer: { email: 'bob@example.test' },
            attendees: [{ email: x.box.email, status: 'NEEDS-ACTION' }]
        };
    const bytes = await compose({
        from: 'bob@example.test',
        to: x.box.email,
        subject: e.subject,
        text: 'Invitation',
        icalEvent: { method: 'REQUEST', content: codec.toICS(e) }
    });
    await x.mail.deliver({ recipient: x.box.email, bytes, deliveryId: 'decline' });
    const invitation = x.scope.list('messages', (m) => !!m.meeting)[0];
    await x.mail.calendar.respond(x.auth, invitation.id, 'DECLINED');
    assert.equal(x.scope.get('messages', invitation.meeting.calendarId), null);
    assert.ok(x.scope.get('calendarHistory', invitation.meeting.calendarId));
    await x.mail.calendar.respond(x.auth, invitation.id, 'ACCEPTED');
    assert.ok(x.scope.get('messages', invitation.meeting.calendarId));
    assert.equal(x.scope.list('outbox').length, 2);
});
test('blind copies reach the SMTP envelope without leaking recipient headers', async (t) => {
    const x = await fixture(t),
        web = new Webmail(x.mail, { ...x.auth, device: { id: 'web:alice' } });
    await web.send({
        clientId: 'bcc-only',
        to: '',
        bcc: 'private@example.test',
        subject: 'Private recipients',
        text: 'Hello',
        attachments: []
    });
    const queued = x.scope.list('outbox')[0];
    assert.deepEqual(queued.recipients, ['private@example.test']);
    const internal = await x.store.getBlob(queued.blob);
    assert.match(internal.toString(), /^Bcc:/m);
    let outgoing;
    await x.mail.flushOutbox({
        sendMail: async (message) => {
            outgoing = message;
            return { accepted: message.envelope.to, rejected: [] };
        }
    });
    assert.doesNotMatch(outgoing.raw.toString(), /^Bcc:/m);
    assert.deepEqual(outgoing.envelope.to, ['private@example.test']);
    const sent = x.scope.list('messages')[0];
    assert.match((await web.read({ id: sent.id })).bcc, /private@example.test/);
    const bytes = Buffer.from(
        'From: a@example.test\r\nBcc: first@example.test,\r\n second@example.test\r\nSubject: Keep\r\n\r\nBcc: body text\x00\xff',
        'latin1'
    );
    const stripped = require('../server/coremx/mime').withoutBlindCopies(bytes);
    assert.equal(
        stripped.toString('latin1'),
        'From: a@example.test\r\nSubject: Keep\r\n\r\nBcc: body text\x00\xff'
    );
});
test('partial SMTP acceptance retries only recipients that were not accepted', async (t) => {
    const x = await fixture(t);
    await x.mail.submit(
        x.auth,
        await compose({
            from: x.box.email,
            to: 'one@example.test,two@example.test',
            subject: 'Partial',
            text: 'Hello'
        }),
        'partial'
    );
    const sent = [];
    await x.mail.flushOutbox({
        sendMail: async (m) => {
            sent.push(m.envelope.to);
            return { accepted: ['one@example.test'], rejected: ['two@example.test'] };
        }
    });
    let pending = x.scope.list('outbox')[0];
    assert.deepEqual(pending.recipients, ['two@example.test']);
    await x.scope.transaction('retry-now', () => [
        { collection: 'outbox', id: pending.id, value: { ...pending, nextAttempt: 0 } }
    ]);
    await x.mail.flushOutbox({
        sendMail: async (m) => {
            sent.push(m.envelope.to);
            return { accepted: ['two@example.test'], rejected: [] };
        }
    });
    assert.deepEqual(sent, [['one@example.test', 'two@example.test'], ['two@example.test']]);
    assert.equal(
        x.scope.list('messages', (m) => m.folder === x.scope.list('folders', (f) => f.type === 5)[0].id)
            .length,
        1
    );
});
test('16.1 meeting time proposals are read from SendResponse and retain the current schedule', async (t) => {
    const x = await fixture(t),
        e = {
            ...event(),
            organizer: { email: 'bob@example.test' },
            attendees: [{ email: x.box.email, status: 'NEEDS-ACTION' }]
        };
    const bytes = await compose({
        from: 'bob@example.test',
        to: x.box.email,
        subject: e.subject,
        text: 'Invitation',
        icalEvent: { method: 'REQUEST', content: codec.toICS(e) }
    });
    await x.mail.deliver({ recipient: x.box.email, bytes, deliveryId: 'proposal' });
    const invitation = x.scope.list('messages', (m) => !!m.meeting)[0];
    const response = await x.execute(
        'MeetingResponse',
        n(
            'MeetingResponse:MeetingResponse',
            n(
                'MeetingResponse:Request',
                f('Search:LongId', invitation.id),
                f('MeetingResponse:UserResponse', 2),
                n(
                    'MeetingResponse:SendResponse',
                    f('MeetingResponse:ProposedStartTime', '20260322T110000Z'),
                    f('MeetingResponse:ProposedEndTime', '20260322T120000Z')
                )
            )
        ),
        x.auth,
        undefined,
        { version: '16.1' }
    );
    assert.equal(value(child(response, 'MeetingResponse:Result'), 'MeetingResponse:Status'), '1');
    const current = x.scope.get('messages', invitation.meeting.calendarId).calendar;
    assert.equal(current.start, e.start);
    assert.equal(current.proposals[x.box.email].start, '2026-03-22T11:00:00.000Z');
    const outgoing = await x.mail.parse(await x.store.getBlob(x.scope.list('outbox')[0].blob));
    assert.match(
        outgoing.attachments.find((a) => a.contentType === 'text/calendar').content.toString(),
        /METHOD:COUNTER/
    );
});
test('forwarded invitations add the recipient to the organizer and accept their response', async (t) => {
    const x = await fixture(t),
        bob = await x.mail.createMailbox({ email: 'bob@example.test', owner: 'bob' }),
        carol = await x.mail.createMailbox({ email: 'carol@example.test', owner: 'carol' }),
        bobAuth = await x.device(bob, 'bob'),
        carolAuth = await x.device(carol, 'carol');
    const saved = await x.mail.calendar.save(x.auth, { ...event(), clientId: 'forward-meeting' });
    let sequence = 0;
    const deliver = async (box) => {
        const scope = x.store.forMailbox(box.id);
        for (const q of scope.list('outbox', (q) => q.status === 'pending')) {
            for (const recipient of q.recipients)
                await x.mail.deliver({
                    recipient,
                    bytes: await x.store.getBlob(q.blob),
                    deliveryId: 'forward-' + ++sequence
                });
            await scope.transaction('forward-delivered-' + sequence, () => [
                { collection: 'outbox', id: q.id, value: { ...q, status: 'queued' } }
            ]);
        }
    };
    await deliver(x.box);
    const source = x.store.forMailbox(bob.id).list('messages', (m) => !!m.meeting)[0];
    const root = n(
        'ComposeMail:SmartForward',
        f('ComposeMail:ClientId', 'forward-to-carol'),
        n('ComposeMail:Source', f('ComposeMail:FolderId', source.folder), f('ComposeMail:ItemId', source.id)),
        n('ComposeMail:Forwardees', n('ComposeMail:Forwardee', f('ComposeMail:Email', carol.email)))
    );
    const response = await x.eas.execute('SmartForward', encode(root), bobAuth, undefined, {
        version: '16.1'
    });
    assert.equal(response.body.length, 0);
    await deliver(bob);
    assert.ok(x.scope.get('messages', saved.id).calendar.attendees.some((a) => a.email === carol.email));
    const invitation = x.store.forMailbox(carol.id).list('messages', (m) => !!m.meeting)[0];
    await x.mail.calendar.respond(carolAuth, invitation.id, 'ACCEPTED');
    await deliver(carol);
    assert.equal(
        x.scope.get('messages', saved.id).calendar.attendees.find((a) => a.email === carol.email).status,
        'ACCEPTED'
    );
});

test('web calendar edits preserve native time-zone rules and can explicitly switch to an IANA zone', async (t) => {
    const x = await fixture(t),
        web = new Webmail(x.mail, x.auth);
    const native = codec.fromEas(codec.toEas(event(), '16.1'), undefined, '16.1');
    native.attendees = [];
    const saved = await x.mail.calendar.save(x.auth, native);
    const opened = await web.handle('calendarGet', { id: saved.id });
    assert.equal(opened.wallStart, '2026-03-22T09:00:00');
    const updated = await web.handle('calendarSave', {
        ...opened.calendar,
        id: saved.id,
        revision: saved.revision,
        clientId: 'native-edit',
        subject: 'Edited in webmail',
        timeZone: 'Original device time zone',
        timezone: null,
        keepNativeZone: true,
        localStart: opened.wallStart,
        localEnd: opened.wallEnd
    });
    assert.equal(updated.calendar.timezone, native.timezone);
    assert.equal(updated.calendar.start, native.start);
    assert.deepEqual(
        codec
            .occurrences(updated.calendar, '2026-03-01T00:00:00Z', '2026-04-30T00:00:00Z')
            .map((r) => r.start),
        ['2026-03-22T09:00:00.000Z', '2026-03-29T08:00:00.000Z', '2026-04-05T08:00:00.000Z']
    );
    const changed = await web.handle('calendarSave', {
        ...updated.calendar,
        id: saved.id,
        revision: updated.revision,
        clientId: 'iana-edit',
        timeZone: 'America/New_York',
        timezone: null,
        keepNativeZone: false,
        localStart: opened.wallStart,
        localEnd: opened.wallEnd
    });
    assert.equal(changed.calendar.start, '2026-03-22T13:00:00.000Z');
    assert.equal(changed.calendar.timezone, null);
    assert.throws(
        () => require('../server/coremx/policy').normalize({ PasswordRecoveryEnabled: 1 }),
        /not supported/
    );
});

test('conversation indexes retain reply ancestry and survive restart', async (t) => {
    const x = await fixture(t),
        root = await x.deliver('Thread root');
    assert.equal(Buffer.from(root.conversationIndex, 'base64').length, 5);
    // The fixture's minimal delivery has no Message-ID; use a proper MIME root.
    const raw = await compose({
        from: 'bob@example.test',
        to: x.box.email,
        subject: 'Thread',
        text: 'First'
    });
    await x.mail.deliver({ recipient: x.box.email, bytes: raw, deliveryId: 'thread-root' });
    const parent = x.scope.list('messages').at(-1);
    await x.mail.deliver({
        recipient: x.box.email,
        deliveryId: 'thread-reply',
        bytes: await compose({
            from: 'bob@example.test',
            to: x.box.email,
            subject: 'Re: Thread',
            text: 'Second',
            inReplyTo: parent.messageId,
            references: [parent.messageId]
        })
    });
    const reply = x.scope.list('messages').at(-1),
        bytes = Buffer.from(reply.conversationIndex, 'base64');
    assert.equal(bytes.length, 10);
    assert.deepEqual(bytes.subarray(0, 5), Buffer.from(parent.conversationIndex, 'base64'));
    await x.restart();
    const data = await x.eas.applicationData(x.scope.get('messages', reply.id), {}, 4096, '16.1');
    assert.deepEqual(child(data, 'Email2:ConversationIndex').children[0], bytes);
    assert.equal(reply.conversation, parent.conversation);
});

test('PIM body preferences truncate calendar notes without corrupting UTF-8', async (t) => {
    const x = await fixture(t);
    const calendar = { ...event(), body: 'é'.repeat(100) };
    const data = await x.eas.applicationData(
        { calendar },
        { preferences: [{ type: 1, size: 5 }] },
        4096,
        '16.1'
    );
    const body = child(data, 'AirSyncBase:Body');
    assert.equal(value(body, 'AirSyncBase:Data'), 'éé');
    assert.equal(value(body, 'AirSyncBase:EstimatedDataSize'), '200');
    assert.equal(value(body, 'AirSyncBase:Truncated'), '1');
    assert.equal(calendar.body.length, 100);
});

test('mailbox appearance persists, remains isolated and rejects invalid modes', async (t) => {
    const x = await fixture(t),
        web = new Webmail(x.mail, x.auth);
    await web.preferences({ appearance: 'dark', timeZone: 'Europe/London' });
    await x.restart();
    const reopened = new Webmail(x.mail, x.auth);
    assert.equal((await reopened.overview()).preferences.appearance, 'dark');
    await reopened.preferences({ density: 'compact' });
    assert.equal((await reopened.overview()).preferences.appearance, 'dark');
    const second = await x.mail.createMailbox({ email: 'bob@example.test', owner: 'bob' });
    assert.equal(
        (await new Webmail(x.mail, await x.device(second)).overview()).preferences.appearance,
        undefined
    );
    await assert.rejects(reopened.preferences({ appearance: 'sepia' }), /Invalid appearance/);
    for (const appearance of ['light', 'system']) {
        await reopened.preferences({ appearance });
        assert.equal((await reopened.overview()).preferences.appearance, appearance);
    }
});
