'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createHttpHandler } = require('../server/coremx/http');
test('HTTP body slots are held until response consumption or cancellation', async () => {
    const handler = createHttpHandler(
        {},
        { store: { failed: false } },
        { publicOrigin: 'https://mail.test', experimentalActiveSync: false }
    );
    const controllers = [];
    const request = () => {
        const c = new AbortController();
        controllers.push(c);
        return { method: 'GET', target: '/healthz', headers: [], body: Readable.from([]), signal: c.signal };
    };
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await handler(request()));
    assert.equal((await handler(request())).status, 503);
    for await (const chunk of results[0].body) assert.ok(chunk.length);
    assert.equal((await handler(request())).status, 200);
    controllers[1].abort();
    assert.equal((await handler(request())).status, 200);
    controllers.forEach((c) => c.abort());
});

test('HTTP ActiveSync negotiates multipart fetch and advertises only supported commands', async (t) => {
    const fixture = require('./helpers/mail');
    const { node: n, encode, decode, child, value } = require('../server/coremx/wbxml');
    const f = await fixture(t);
    const message = await f.deliver('Through HTTP');
    const credential = await f.mail.issueDevice(f.box, 'HTTP phone');
    const handler = createHttpHandler({}, f.mail, {
        publicOrigin: 'https://mail.test',
        experimentalActiveSync: true
    });
    const bytes = encode(
        n(
            'ItemOperations:ItemOperations',
            n(
                'ItemOperations:Fetch',
                n('ItemOperations:Store', 'Mailbox'),
                n('AirSync:CollectionId', message.folder),
                n('AirSync:ServerId', message.id)
            )
        )
    );
    const request = {
        method: 'POST',
        target: '/Microsoft-Server-ActiveSync?Cmd=ItemOperations&DeviceId=httpphone&DeviceType=Test',
        peer: '127.0.0.1',
        headers: [
            [
                'Authorization',
                'Basic ' + Buffer.from(f.box.email + ':' + credential.secret).toString('base64')
            ],
            ['MS-ASProtocolVersion', '14.1'],
            ['MS-ASAcceptMultiPart', 'T']
        ],
        body: Readable.from([bytes]),
        signal: new AbortController().signal
    };
    const provision = async (body) => {
        const response = await handler({
            ...request,
            target: request.target.replace('Cmd=ItemOperations', 'Cmd=Provision'),
            body: Readable.from([encode(body)])
        });
        const chunks = [];
        for await (const chunk of response.body) chunks.push(chunk);
        return decode(Buffer.concat(chunks));
    };
    const policyRequest = n(
        'Provision:Provision',
        n('Provision:Policies', n('Provision:Policy', n('Provision:PolicyType', 'MS-EAS-Provisioning-WBXML')))
    );
    const pending = value(
        child(child(await provision(policyRequest), 'Provision:Policies'), 'Provision:Policy'),
        'Provision:PolicyKey'
    );
    const ack = n(
        'Provision:Provision',
        n(
            'Provision:Policies',
            n(
                'Provision:Policy',
                n('Provision:PolicyType', 'MS-EAS-Provisioning-WBXML'),
                n('Provision:PolicyKey', pending),
                n('Provision:Status', '1')
            )
        )
    );
    const final = value(
        child(child(await provision(ack), 'Provision:Policies'), 'Provision:Policy'),
        'Provision:PolicyKey'
    );
    request.headers.push(['X-MS-PolicyKey', final]);
    const response = await handler(request);
    assert.equal(response.status, 200);
    assert.equal(new Map(response.headers).get('content-type'), 'application/vnd.ms-sync.multipart');
    const chunks = [];
    for await (const chunk of response.body) chunks.push(chunk);
    const result = Buffer.concat(chunks);
    const metadata = decode(
        result.subarray(result.readUInt32LE(4), result.readUInt32LE(4) + result.readUInt32LE(8))
    );
    assert.equal(
        value(
            child(child(metadata, 'ItemOperations:Response'), 'ItemOperations:Fetch'),
            'ItemOperations:Status'
        ),
        '1'
    );
    const options = await handler({ ...request, method: 'OPTIONS', body: Readable.from([]) });
    const headers = new Map(options.headers);
    assert.equal(headers.get('ms-asprotocolversions'), '14.1,16.0,16.1');
    assert.ok(headers.get('ms-asprotocolcommands').includes('ItemOperations'));
    assert.equal(headers.get('ms-asprotocolcommands').includes('MeetingResponse'), true);
    for await (const _ of options.body) {
        /* Release the response slot. */
    }
});
