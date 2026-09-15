'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { MailStore } = require('../../server/coremx/store');
const { MailService } = require('../../server/coremx/mail');
const { ActiveSync } = require('../../server/coremx/activesync');
const w = require('../../server/coremx/wbxml');
module.exports = async function fixture(t) {
    const directory = await fs.mkdtemp(path.resolve('.cache/eas-'));
    const kv = require('./kv')();
    let store = await new MailStore({ runDirectory: directory, kv }).open(); let mail = new MailService(store); let eas = new ActiveSync(mail);
    t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
    await store.transaction('domain', () => [{ collection: 'domains', id: 'domain', value: { name: 'example.test' } }]);
    const box = await mail.createMailbox({ email: 'alice@example.test', owner: 'alice' });
    async function device(mailbox = box, label = 'phone') {
        const credential = await mail.issueDevice(mailbox, label);
        return mail.authenticate('Basic ' + Buffer.from(mailbox.email + ':' + credential.secret).toString('base64'), credential.id, label);
    }
    const auth = await device();
    return {
        auth, box, device, get store() { return store; }, get scope() { return store.forMailbox(box.id); }, get mail() { return mail; }, get eas() { return eas; },
        async restart() { await store.close(); store = await new MailStore({ runDirectory: directory, kv }).open(); mail = new MailService(store); eas = new ActiveSync(mail); },
        async execute(command, root, identity = auth, signal = new AbortController().signal, transport) { const response = await eas.execute(command, w.encode(root), identity, signal, transport); return w.decode(response.body); },
        async sync(folder, token = '0', extra = [], identity = auth) {
            const root = w.node('AirSync:Sync', w.node('AirSync:Collections', w.node('AirSync:Collection', w.node('AirSync:SyncKey', token), w.node('AirSync:CollectionId', folder.id), extra)));
            const response = await this.execute('Sync', root, identity);
            return w.child(w.child(response, 'AirSync:Collections'), 'AirSync:Collection');
        },
        async deliver(subject, date = new Date(), text = 'Body', recipient = box.email) {
            await mail.deliver({ recipient, deliveryId: crypto.randomUUID(), bytes: Buffer.from(`From: sender@example.test\r\nTo: ${recipient}\r\nSubject: ${subject}\r\nDate: ${date.toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`) });
            return store.forMailbox(mail.mailbox(recipient).id).list('messages').at(-1);
        }
    };
};
