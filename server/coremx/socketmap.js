'use strict';
const net = require('node:net');
const fs = require('node:fs/promises');
async function startSocketMap({ socketPath, mail }) {
    await require('./unix').removeStaleSocket(socketPath);
    const server = net.createServer((socket) => {
        let input = Buffer.alloc(0);
        socket.setTimeout(10000, () => socket.destroy());
        socket.on('error', () => {});
        socket.on('data', (chunk) => {
            input = Buffer.concat([input, chunk]);
            if (input.length > 8192) return socket.destroy();
            while (true) {
                const colon = input.indexOf(':');
                if (colon < 0) return;
                const digits = input.subarray(0, colon).toString('ascii');
                if (!/^\d{1,4}$/.test(digits)) return socket.destroy();
                const length = Number(digits);
                if (length > 4096) return socket.destroy();
                if (input.length < colon + length + 2) return;
                if (input[colon + length + 1] !== 44) return socket.destroy();
                const query = input.subarray(colon + 1, colon + length + 1).toString('utf8');
                input = input.subarray(colon + length + 2);
                const space = query.indexOf(' ');
                const table = query.slice(0, space);
                const key = query.slice(space + 1).toLowerCase();
                let result = 'NOTFOUND ';
                try {
                    if (mail.store.failed) result = 'TEMP storage unavailable';
                    else if (table === 'domains' && mail.store.list('domains', (d) => d.name === key).length)
                        result = 'OK 1';
                    else if (table === 'recipients' && mail.mailbox(key)) result = 'OK 1';
                } catch {
                    result = 'NOTFOUND ';
                }
                const bytes = Buffer.from(result);
                socket.write(Buffer.concat([Buffer.from(bytes.length + ':'), bytes, Buffer.from(',')]));
            }
        });
    });
    server.maxConnections = 32;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
    });
    await fs.chmod(socketPath, 0o660);
    return server;
}
module.exports = { startSocketMap };
