'use strict';
const net = require('node:net');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { LIMIT } = require('./store');
// Local LMTP only. No TCP listeners and no relay path.
async function startLMTP({ socketPath, mail }) {
    await require('./unix').removeStaleSocket(socketPath);
    const server = net.createServer((socket) => {
        let buffer = Buffer.alloc(0),
            sender = null,
            recipients = [],
            data = null,
            length = 0,
            overflow = false;
        let chain = Promise.resolve();
        const reply = (text) => socket.write(text + '\r\n');
        const reset = () => {
            sender = null;
            recipients = [];
            data = null;
            length = 0;
            overflow = false;
        };
        socket.setTimeout(60000, () => socket.destroy());
        socket.on('error', () => {});
        reply('220 coremx LMTP');
        async function line(bytes) {
            if (data) {
                if (bytes.equals(Buffer.from('.'))) {
                    const raw = Buffer.concat(data);
                    const deliveryId = crypto.createHash('sha256').update(sender).update(raw).digest('hex');
                    for (const recipient of recipients) {
                        if (overflow) {
                            reply('552 5.3.4 Message too large');
                            continue;
                        }
                        try {
                            await mail.deliver({ recipient, bytes: raw, deliveryId });
                            reply('250 2.1.5 Delivered');
                        } catch (error) {
                            reply(
                                error.permanent
                                    ? '550 5.1.1 Unknown recipient'
                                    : '451 4.3.0 Delivery unavailable'
                            );
                        }
                    }
                    reset();
                    return;
                }
                if (bytes[0] === 46) bytes = bytes.subarray(1);
                length += bytes.length + 2;
                if (length > LIMIT) {
                    overflow = true;
                    data = [];
                }
                if (!overflow) data.push(bytes, Buffer.from('\r\n'));
                return;
            }
            const command = bytes.toString('ascii');
            const verb = command.split(' ')[0].toUpperCase();
            if (verb === 'LHLO') {
                reset();
                reply(`250-coremx\r\n250-SIZE ${LIMIT}\r\n250-8BITMIME\r\n250 ENHANCEDSTATUSCODES`);
            } else if (verb === 'MAIL') {
                const m = /^MAIL FROM:<([^<>\r\n]*)>(?: SIZE=\d+)?(?: BODY=8BITMIME)?$/i.exec(command);
                if (!m) reply('501 5.5.2 Invalid sender');
                else {
                    reset();
                    sender = m[1];
                    reply('250 2.1.0 Sender accepted');
                }
            } else if (verb === 'RCPT') {
                const m = /^RCPT TO:<([^<>\r\n]+)>$/i.exec(command);
                let box;
                try {
                    box = m && mail.mailbox(m[1]);
                } catch {}
                if (sender === null) reply('503 5.5.1 MAIL required');
                else if (!box) reply('550 5.1.1 Unknown recipient');
                else if (recipients.length >= 100) reply('452 4.5.3 Too many recipients');
                else {
                    recipients.push(m[1]);
                    reply('250 2.1.5 Recipient accepted');
                }
            } else if (verb === 'DATA') {
                if (!recipients.length) reply('503 5.5.1 RCPT required');
                else {
                    data = [];
                    reply('354 End with <CRLF>.<CRLF>');
                }
            } else if (verb === 'RSET') {
                reset();
                reply('250 2.0.0 Reset');
            } else if (verb === 'NOOP') reply('250 2.0.0 OK');
            else if (verb === 'QUIT') socket.end('221 2.0.0 Bye\r\n');
            else reply('502 5.5.1 Unsupported command');
        }
        socket.on('data', (chunk) => {
            socket.pause();
            buffer = Buffer.concat([buffer, chunk]);
            chain = chain
                .then(async () => {
                    let end;
                    while ((end = buffer.indexOf('\r\n')) >= 0) {
                        if (end > 65536) throw new Error('LMTP line limit');
                        const bytes = buffer.subarray(0, end);
                        buffer = buffer.subarray(end + 2);
                        await line(bytes);
                    }
                    if (buffer.length > 65536) throw new Error('LMTP line limit');
                    socket.resume();
                })
                .catch(() => socket.destroy());
        });
    });
    server.maxConnections = 2;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
    });
    await fs.chmod(socketPath, 0o660);
    return server;
}
module.exports = { startLMTP };
