'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { ActiveSync, commands } = require('./activesync');
const { XMLParser, XMLValidator } = require('./central')('node_modules/fast-xml-parser');
const { LIMIT } = require('./store');
const protocol = require('./protocol');
const xml = (s) =>
    String(s).replace(
        /[<>&"']/g,
        (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]
    );
async function readBody(stream, limit = LIMIT) {
    const chunks = [];
    let length = 0;
    for await (const chunk of stream) {
        length += chunk.length;
        if (length > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}
function createHttpHandler(common, mail, config) {
    const eas = new ActiveSync(mail);
    let heavy = 0,
        held = 0;
    const route = async (request) => {
        const headers = Object.fromEntries(request.headers.map(([k, v]) => [k.toLowerCase(), v]));
        const url = new URL(request.target, config.publicOrigin);
        const pathname = url.pathname.toLowerCase();
        const base = [
            ['cache-control', 'no-store'],
            ['x-content-type-options', 'nosniff']
        ];
        const reply = (status, body = '', type = 'text/plain; charset=utf-8') => ({
            status,
            headers: [...base, ['content-type', type]],
            body
        });
        let parameters;
        try {
            parameters = pathname === '/microsoft-server-activesync' ? protocol.query(url, headers) : {};
        } catch {
            return reply(400);
        }
        const ping = pathname === '/microsoft-server-activesync' && parameters.command === 'Ping';
        try {
            if (pathname === '/healthz') {
                await readBody(request.body, 0);
                return reply(
                    mail.store.failed ? 503 : 200,
                    JSON.stringify({ ready: !mail.store.failed }),
                    'application/json'
                );
            }
            if (pathname === '/api/v1') {
                if (request.method !== 'POST') return reply(405);
                // HTTP portal calls require same-origin browser requests. Native EAS has its own credentials.
                if (headers.origin !== config.publicOrigin) return reply(403);
                const input = JSON.parse((await readBody(request.body, 1024 * 1024)).toString('utf8'));
                const result = await common.apihandler.handler(common, {
                    body: input,
                    headers: { 'user-agent': headers['user-agent'] || '', 'x-forwarded-for': request.peer },
                    ip: request.peer,
                    signal: request.signal
                });
                return reply(200, JSON.stringify(result), 'application/json');
            }
            if (
                pathname === '/autodiscover/autodiscover.xml' ||
                pathname === '/microsoft-server-activesync'
            ) {
                if (!config.experimentalActiveSync) {
                    await readBody(request.body, ping ? 16384 : LIMIT);
                    return reply(503, 'ActiveSync conformance validation pending');
                }
                if (request.method === 'OPTIONS' && pathname === '/microsoft-server-activesync') {
                    await readBody(request.body, 0);
                    return {
                        status: 200,
                        headers: [
                            ...base,
                            ['allow', 'OPTIONS, POST'],
                            ['ms-asprotocolversions', protocol.versions.join(',')],
                            ['ms-asprotocolcommands', commands.join(',')]
                        ],
                        body: ''
                    };
                }
                if (request.method !== 'POST') return reply(405);
                const auth = await mail.authenticate(
                    headers.authorization,
                    request.peer,
                    parameters.deviceId
                );
                if (!auth) {
                    await readBody(request.body, ping ? 16384 : LIMIT);
                    return {
                        status: 401,
                        headers: [...base, ['www-authenticate', 'Basic realm="CoreMX", charset="UTF-8"']],
                        body: ''
                    };
                }
                const bytes = await readBody(request.body, ping ? 16384 : LIMIT);
                if (pathname === '/autodiscover/autodiscover.xml') {
                    const body = bytes.toString('utf8');
                    if (
                        bytes.length > 16384 ||
                        /<!DOCTYPE|<!ENTITY/i.test(body) ||
                        XMLValidator.validate(body) !== true
                    )
                        return reply(400);
                    const parsed = new XMLParser({
                        processEntities: false,
                        removeNSPrefix: true,
                        ignoreAttributes: true
                    }).parse(body);
                    if (parsed?.Autodiscover?.Request?.EMailAddress?.toLowerCase() !== auth.mailbox.email)
                        return reply(403);
                    const endpoint = xml(config.publicOrigin + '/Microsoft-Server-ActiveSync');
                    return reply(
                        200,
                        `<?xml version="1.0" encoding="utf-8"?><Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006"><Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/mobilesync/responseschema/2006"><Culture>en:en</Culture><User><DisplayName>${xml(auth.mailbox.email)}</DisplayName><EMailAddress>${xml(auth.mailbox.email)}</EMailAddress></User><Action><Settings><Server><Type>MobileSync</Type><Url>${endpoint}</Url><Name>${endpoint}</Name></Server></Settings></Action></Response></Autodiscover>`,
                        'text/xml; charset=utf-8'
                    );
                }
                if (!protocol.versions.includes(parameters.version))
                    return reply(400, 'Unsupported protocol version');
                if (!parameters.deviceId || !parameters.deviceType || parameters.deviceType.length > 64)
                    return reply(400);
                if (auth.device.protocolVersion !== parameters.version)
                    await mail.store.transaction(
                        'device-version:' + require('node:crypto').randomUUID(),
                        (store) => [
                            {
                                collection: 'devices',
                                id: auth.device.id,
                                value: {
                                    ...store.get('devices', auth.device.id),
                                    protocolVersion: parameters.version,
                                    deviceType: parameters.deviceType
                                }
                            }
                        ]
                    );
                if (parameters.command === 'Sync' && bytes.length <= 65536) {
                    try {
                        const w = require('./wbxml');
                        const root = bytes.length
                            ? w.decode(bytes)
                            : mail.store.forMailbox(auth.mailbox.id).get('clientState', auth.device.id)?.sync;
                        if (w.child(root, 'AirSync:Wait') || w.child(root, 'AirSync:HeartbeatInterval'))
                            request.releaseHeavy?.();
                    } catch {
                        /* execute returns the WBXML parse error */
                    }
                }
                return await eas.execute(parameters.command, bytes, auth, request.signal, {
                    ...parameters,
                    enforcePolicy: true
                });
            }
            if (!['GET', 'HEAD'].includes(request.method)) return reply(405);
            await readBody(request.body, 0);
            const root = path.resolve(config.portalDirectory);
            const requested = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            if (!requested.startsWith(root + path.sep) && requested !== root) return reply(404);
            let filename = requested;
            try {
                const stat = await fs.stat(filename);
                if (!stat.isFile()) filename = path.join(root, 'index.html');
            } catch {
                if (path.extname(url.pathname)) return reply(404);
                filename = path.join(root, 'index.html');
            }
            const real = await fs.realpath(filename);
            if (!real.startsWith(root + path.sep)) return reply(404);
            const type =
                {
                    '.html': 'text/html; charset=utf-8',
                    '.js': 'application/javascript',
                    '.css': 'text/css',
                    '.json': 'application/json',
                    '.svg': 'image/svg+xml',
                    '.png': 'image/png',
                    '.ico': 'image/x-icon',
                    '.woff2': 'font/woff2'
                }[path.extname(filename)] || 'application/octet-stream';
            return reply(200, request.method === 'HEAD' ? '' : createReadStream(real), type);
        } catch (error) {
            return reply(error.status || 400, 'Request could not be processed');
        }
    };
    return async (request) => {
        const url = new URL(request.target, config.publicOrigin);
        let command;
        try {
            command = protocol.query(url).command;
        } catch {}
        const ping = url.pathname.toLowerCase() === '/microsoft-server-activesync' && command === 'Ping';
        if (held >= 128 || (!ping && heavy >= 4)) return { status: 503, body: '' };
        held++;
        let counted = !ping;
        if (counted) heavy++;
        const releaseHeavy = () => {
            if (counted) {
                counted = false;
                heavy--;
            }
        };
        let result,
            ready = false,
            released = false;
        const release = () => {
            if (released) return;
            released = true;
            held--;
            releaseHeavy();
            request.signal?.removeEventListener('abort', cancel);
            result?.body?.destroy?.();
        };
        const cancel = () => {
            if (ready) release();
        };
        request.signal?.addEventListener('abort', cancel, { once: true });
        try {
            result = await route({ ...request, releaseHeavy });
            ready = true;
            if (request.signal?.aborted) {
                release();
                return { status: 499, body: '' };
            }
            const content = result.body ?? '';
            return {
                ...result,
                body: (async function* () {
                    try {
                        if (typeof content === 'string' || Buffer.isBuffer(content))
                            yield Buffer.from(content);
                        else for await (const chunk of content) yield chunk;
                    } finally {
                        release();
                    }
                })()
            };
        } catch (error) {
            release();
            throw error;
        }
    };
}
module.exports = { createHttpHandler, readBody };
