'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { MailStore } = require('../coremx/store');
const { MailService } = require('../coremx/mail');
const { startHttpWorker } = require('../modules/httpWorker');
const { createHttpHandler } = require('../coremx/http');
function configuration(config) {
    const c = config.coremx || {};
    const url = new URL(c.publicOrigin);
    if (url.protocol !== 'https:' || url.origin !== c.publicOrigin)
        throw new Error('CoreMX requires an explicit HTTPS publicOrigin');
    if (config.webauthnOrigin !== url.origin || config.webauthnRpId !== url.hostname)
        throw new Error('CoreMX WebAuthn origin/RP must match publicOrigin');
    for (const field of ['runDirectory', 'portalDirectory'])
        if (!path.isAbsolute(c[field] || '')) throw new Error('CoreMX requires absolute ' + field);
    return c;
}
module.exports = {
    allowedControllers: [
        'coremx',
        'auth',
        'keychainman',
        'passkeyLoginChallenge',
        'passkeyLoginComplete',
        'createdevice',
        'registration',
        'recoverpassword',
        'masterhint',
        'dashman',
        'userman'
    ],
    runtimeProcesses(defaults, config) {
        const c = configuration(config);
        require('node:fs').mkdirSync(c.runDirectory, { recursive: true, mode: 0o750 });
        process.env.CENTRALFW_WORKER_SOCKET = path.join(c.runDirectory, 'websocket.sock');
        process.env.CENTRALFW_HTTP_WORKER_SOCKET = path.join(c.runDirectory, 'http.sock');
        process.env.CENTRALFW_HTTP_HOSTS = new URL(c.publicOrigin).host;
        process.env.CENTRALFW_HTTP_PEERS = (c.trustedProxyAddresses || ['127.0.0.1', '::1']).join(',');
        process.env.CENTRALFW_BIND_ADDR = c.ingressAddress || '127.0.0.1:30100';
        return defaults
            .filter((p) => ['main-1', 'cluster_validator', 'centralfw'].includes(p.name))
            .map((p) => (p.name === 'main-1' ? { ...p, args: ['socket'] } : p));
    },
    async configure(common, config) {
        configuration(config);
        common.coremx = require('../coremx/controller');
    },
    async start(common) {
        if (!process.argv.includes('socket')) return;
        const config = configuration(common.globalsystemconfiguration);
        await fs.mkdir(config.runDirectory, { recursive: true, mode: 0o750 });
        const store = await new MailStore({
            runDirectory: config.runDirectory,
            kv: common.encryptedkv
        }).open();
        const mail = new MailService(store);
        common.coremxMail = mail;
        mail.configuration = config;
        mail.directoryProvider = () => common.dbmgr.findMany('users', {});
        const { startLMTP } = require('../coremx/lmtp');
        const { startSocketMap } = require('../coremx/socketmap');
        const lmtp = await startLMTP({ socketPath: path.join(config.runDirectory, 'lmtp.sock'), mail });
        const maps = await startSocketMap({
            socketPath: path.join(config.runDirectory, 'lookup.sock'),
            mail
        });
        const worker = startHttpWorker({
            socketPath: process.env.CENTRALFW_HTTP_WORKER_SOCKET,
            handler: createHttpHandler(common, mail, config),
            onError: (error) => console.error('[coremx] HTTP transport:', error.code || error.name)
        });
        const transport = require('nodemailer').createTransport({
            host: '127.0.0.1',
            port: config.submissionPort || 10025,
            secure: false,
            ignoreTLS: true,
            connectionTimeout: 10000,
            socketTimeout: 30000
        });
        const timer = setInterval(
            () => mail.flushOutbox(transport).catch(() => console.error('[coremx] outbox unavailable')),
            10000
        );
        let closing = false;
        const close = async () => {
            if (closing) return;
            closing = true;
            clearInterval(timer);
            worker.close();
            lmtp.close();
            maps.close();
            transport.close();
            await store.close();
            for (const name of ['lmtp.sock', 'lookup.sock'])
                await fs.unlink(path.join(config.runDirectory, name)).catch(() => {});
            process.exit(0);
        };
        process.once('SIGTERM', close);
        process.once('SIGINT', close);
        store.on('unavailable', () => {
            clearInterval(timer);
            worker.close();
            transport.close();
            lmtp.close();
            console.error('[coremx] durable storage unavailable; restarting for recovery');
            setTimeout(() => process.exit(1), 100);
        });
    }
};
