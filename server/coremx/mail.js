'use strict';
const crypto = require('node:crypto');
const central = require('./central');
const { simpleParser } = central('node_modules/mailparser');
const id = () => crypto.randomUUID();
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
function address(value) {
    const email = String(value || '')
        .trim()
        .toLowerCase();
    if (
        email.length > 254 ||
        !/^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email)
    )
        throw new Error('Invalid email address');
    return email;
}
const folders = [
    ['Inbox', 2],
    ['Drafts', 3],
    ['Deleted Items', 4],
    ['Sent Items', 5],
    ['Outbox', 6],
    ['Tasks', 7],
    ['Calendar', 8],
    ['Contacts', 9],
    ['Notes', 10],
    ['Junk', 12]
];
class MailService {
    constructor(store) {
        this.store = store;
        this.attempts = new Map();
        this.calendar = new (require('./calendar').CalendarService)(this);
        this.search = new (require('./search').SearchService)(this);
        this.policy = new (require('./policy').PolicyService)(this);
    }
    mailbox(email) {
        email = address(email);
        const alias = this.store.list('aliases', (a) => a.email === email)[0];
        return this.store.list('mailboxes', (m) => m.email === (alias?.target || email) && m.enabled)[0];
    }
    async createMailbox({ email, owner, quotaBytes = 1024 * 1024 * 1024 }) {
        email = address(email);
        if (!owner || !Number.isSafeInteger(quotaBytes) || quotaBytes < 1)
            throw new Error('Owner and quota required');
        const mailboxId = id();
        await this.store.transaction('mailbox:' + email, (s) => {
            if (s.list('mailboxes', (m) => m.email === email).length) throw new Error('Mailbox exists');
            if (!s.list('domains', (d) => d.name === email.split('@')[1]).length)
                throw new Error('Domain not configured');
            return [
                {
                    collection: 'mailboxes',
                    id: mailboxId,
                    value: { email, owner, quotaBytes, usedBytes: 0, enabled: true }
                },
                ...folders.map(([name, type]) =>
                    this.store.forMailbox(mailboxId).change({
                        collection: 'folders',
                        id: id(),
                        value: { mailbox: mailboxId, name, type, parent: '0' }
                    })
                )
            ];
        });
        return this.mailbox(email);
    }
    async issueDevice(mailbox, label) {
        const deviceId = id();
        const secret = crypto.randomBytes(32).toString('base64url');
        await this.store.transaction('device:' + deviceId, () => [
            {
                collection: 'devices',
                id: deviceId,
                value: {
                    mailbox: mailbox.id,
                    label: String(label || 'Mail device').slice(0, 100),
                    verifier: hash(secret),
                    revoked: false,
                    createdAt: new Date().toISOString()
                }
            }
        ]);
        return { id: deviceId, secret: deviceId + '.' + secret };
    }
    async revokeDevice(deviceId) {
        await this.store.transaction('revoke:' + deviceId, (s) => {
            const d = s.get('devices', deviceId);
            if (!d) throw new Error('Unknown device');
            return [{ collection: 'devices', id: deviceId, value: { ...d, revoked: true } }];
        });
    }
    async authenticate(authorization, peer, easDeviceId) {
        const now = Date.now();
        const rateKey = hash(String(peer));
        let entry = this.attempts.get(rateKey);
        if (!entry || entry.until < now) {
            entry = { count: 0, until: now + 600000 };
            this.attempts.delete(rateKey);
            this.attempts.set(rateKey, entry);
        }
        if (this.attempts.size > 10000) this.attempts.delete(this.attempts.keys().next().value);
        if (++entry.count > 30) return null;
        if (
            typeof authorization !== 'string' ||
            authorization.length > 2048 ||
            !authorization.startsWith('Basic ')
        )
            return null;
        const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        if (colon < 1) return null;
        let mailbox;
        try {
            mailbox = this.mailbox(decoded.slice(0, colon));
        } catch {
            return null;
        }
        const [deviceId, secret, extra] = decoded.slice(colon + 1).split('.');
        if (extra || !/^[A-Za-z0-9_-]{43}$/.test(secret || '')) return null;
        const device = this.store.get('devices', deviceId);
        const expected = Buffer.from(device?.verifier || '0'.repeat(64), 'hex');
        if (
            !crypto.timingSafeEqual(Buffer.from(hash(secret), 'hex'), expected) ||
            !mailbox ||
            !device ||
            device.revoked ||
            device.mailbox !== mailbox.id
        )
            return null;
        if (easDeviceId) {
            if (!/^[a-zA-Z0-9]{1,64}$/.test(easDeviceId)) return null;
            if (device.easDeviceId && device.easDeviceId !== easDeviceId) return null;
            if (!device.easDeviceId)
                await this.store.transaction('bind:' + device.id, (s) => [
                    {
                        collection: 'devices',
                        id: device.id,
                        value: { ...s.get('devices', device.id), easDeviceId }
                    }
                ]);
            if (this.store.get('devices', device.id).easDeviceId !== easDeviceId) return null;
        }
        entry.count = 0;
        return { mailbox, device: this.store.get('devices', device.id) };
    }
    async parse(bytes) {
        return simpleParser(bytes, {
            skipHtmlToText: false,
            skipTextToHtml: true,
            skipImageLinks: true,
            maxHtmlLengthToParse: 1024 * 1024,
            checksumAlgo: 'sha256'
        });
    }
    async deliver({ recipient, bytes, deliveryId }) {
        if (this.store.failed) throw new Error('Mail storage unavailable');
        const mailbox = this.mailbox(recipient);
        if (!mailbox) throw Object.assign(new Error('Unknown recipient'), { permanent: true });
        const operation = `delivery:${mailbox.id}:${hash(deliveryId)}`;
        if (this.store.operations.has(operation)) return;
        if (mailbox.usedBytes + bytes.length > mailbox.quotaBytes) throw new Error('Mailbox quota exceeded');
        const blob = await this.store.putBlob(bytes);
        const parsed = await this.parse(bytes);
        const messageId = id();
        const meeting = this.calendar.parseInvitation(parsed);
        const scope = this.store.forMailbox(mailbox.id);
        const inbox = scope.list('folders', (f) => f.type === 2)[0];
        await scope.transaction(operation, (s) => {
            const current = s.get('mailboxes', mailbox.id);
            if (!current.enabled) throw new Error('Mailbox disabled');
            if (current.usedBytes + bytes.length > current.quotaBytes)
                throw new Error('Mailbox quota exceeded');
            return [
                {
                    collection: 'messages',
                    id: messageId,
                    value: {
                        mailbox: mailbox.id,
                        folder: inbox.id,
                        blob,
                        size: bytes.length,
                        subject: parsed.subject || '',
                        from: parsed.from?.text || '',
                        to: parsed.to?.text || '',
                        date: (parsed.date || new Date()).toISOString(),
                        read: false,
                        meeting,
                        preview: String(parsed.text || '')
                            .replace(/\s+/g, ' ')
                            .slice(0, 240),
                        hasAttachments: parsed.attachments.length > 0,
                        messageId: parsed.messageId,
                        references: parsed.references || [],
                        conversationIndex: require('./conversation').index(
                            s,
                            parsed,
                            (parsed.date || new Date()).toISOString()
                        ),
                        conversation: hash(
                            String(
                                (Array.isArray(parsed.references)
                                    ? parsed.references[0]
                                    : parsed.references) ||
                                    parsed.inReplyTo ||
                                    parsed.messageId ||
                                    messageId
                            )
                        )
                    }
                },
                {
                    collection: 'mailboxes',
                    id: mailbox.id,
                    value: { ...current, usedBytes: current.usedBytes + bytes.length }
                },
                ...this.calendar.ingestChanges(s, meeting)
            ];
        });
    }
    async envelope(bytes, mailbox) {
        const parsed = await this.parse(bytes);
        if (parsed.from?.value?.length !== 1 || address(parsed.from.value[0].address) !== mailbox.email)
            throw new Error('Sender is not this mailbox');
        const recipients = [
            ...new Set(
                [parsed.to, parsed.cc, parsed.bcc]
                    .flatMap((v) => v?.value || [])
                    .map((v) => address(v.address))
            )
        ];
        if (!recipients.length || recipients.length > 100) throw new Error('Invalid recipient count');
        return { sender: mailbox.email, recipients };
    }
    async submit(auth, bytes, clientId, saveInSent = true, extraChanges = () => []) {
        if (this.store.failed) throw new Error('Mail storage unavailable');
        if (!clientId || clientId.length > 128) throw new Error('Client submission id required');
        const operation = `send:${auth.mailbox.id}:${auth.device.id}:${hash(clientId)}`;
        if (this.store.operations.has(operation)) return;
        const box = this.store.get('mailboxes', auth.mailbox.id);
        const scope = this.store.forMailbox(box.id);
        const queuedBytes = scope
            .list('outbox', (e) => e.status === 'pending')
            .reduce((n, e) => n + (e.reservedBytes ?? e.size ?? 0), 0);
        if (!box.enabled || box.usedBytes + queuedBytes + bytes.length > box.quotaBytes)
            throw new Error('Mailbox quota exceeded');
        const parsed = await this.parse(bytes);
        if (parsed.from?.value?.length !== 1 || address(parsed.from.value[0].address) !== auth.mailbox.email)
            throw new Error('Sender is not this mailbox');
        const recipients = [parsed.to, parsed.cc, parsed.bcc]
            .flatMap((v) => v?.value || [])
            .map((v) => address(v.address));
        if (!recipients.length || recipients.length > 100) throw new Error('Invalid recipient count');
        const blob = await this.store.putBlob(bytes);
        const outboxId = id();
        await scope.transaction(operation, (store) => {
            const current = store.get('mailboxes', auth.mailbox.id);
            const pending = store
                .list('outbox', (e) => e.status === 'pending')
                .reduce((n, e) => n + (e.reservedBytes ?? e.size ?? 0), 0);
            if (!current.enabled || current.usedBytes + pending + bytes.length > current.quotaBytes)
                throw new Error('Mailbox quota exceeded');
            return [
                {
                    collection: 'outbox',
                    id: outboxId,
                    value: {
                        mailbox: auth.mailbox.id,
                        sender: auth.mailbox.email,
                        recipients,
                        blob,
                        size: bytes.length,
                        saveInSent,
                        status: 'pending',
                        attempts: 0,
                        nextAttempt: 0
                    }
                },
                ...extraChanges(store)
            ];
        });
    }
    async flushOutbox(transport) {
        if (this.flushing || this.store.failed) return;
        this.flushing = true;
        try {
            let remaining = 20;
            for (const mailbox of this.store.list('mailboxes')) {
                if (!remaining) break;
                const scope = this.store.forMailbox(mailbox.id);
                const ready = scope
                    .list('outbox', (x) => x.status === 'pending' && x.nextAttempt <= Date.now())
                    .slice(0, remaining);
                for (const entry of ready) {
                    remaining--;
                    try {
                        const raw = await this.store.getBlob(entry.blob);
                        const parsed = await this.parse(raw);
                        const result = await transport.sendMail({
                            envelope: { from: entry.sender, to: entry.recipients },
                            raw: require('./mime').withoutBlindCopies(raw)
                        });
                        if (result.rejected?.length) {
                            const accepted = new Set(
                                (result.accepted || []).map((email) => String(email).toLowerCase())
                            );
                            const recipients = entry.recipients.filter((email) => !accepted.has(email));
                            if (recipients.length === entry.recipients.length)
                                throw new Error('Postfix rejected submission recipients');
                            await scope.transaction(`partial:${entry.id}:${entry.attempts}`, () => [
                                {
                                    collection: 'outbox',
                                    id: entry.id,
                                    value: {
                                        ...entry,
                                        recipients,
                                        deliveredRecipients: [
                                            ...(entry.deliveredRecipients || []),
                                            ...entry.recipients.filter((email) => accepted.has(email))
                                        ],
                                        attempts: entry.attempts + 1,
                                        nextAttempt: Date.now() + 30000
                                    }
                                }
                            ]);
                            continue;
                        }
                        await scope.transaction('queued:' + entry.id, (store) => {
                            const changes = [
                                {
                                    collection: 'outbox',
                                    id: entry.id,
                                    value: { ...entry, status: 'queued', queuedAt: new Date().toISOString() }
                                }
                            ];
                            if (entry.saveInSent) {
                                const box = store.get('mailboxes', entry.mailbox);
                                const sent = store.list('folders', (f) => f.type === 5)[0];
                                changes.push({
                                    collection: 'messages',
                                    id: entry.id,
                                    value: {
                                        mailbox: box.id,
                                        folder: sent.id,
                                        blob: entry.blob,
                                        size: raw.length,
                                        date: new Date().toISOString(),
                                        read: true,
                                        subject: parsed.subject || '',
                                        from: parsed.from?.text || '',
                                        to: parsed.to?.text || '',
                                        preview: String(parsed.text || '')
                                            .replace(/\s+/g, ' ')
                                            .slice(0, 240),
                                        hasAttachments: parsed.attachments.length > 0,
                                        messageId: parsed.messageId,
                                        references: parsed.references || [],
                                        conversationIndex: require('./conversation').index(
                                            store,
                                            parsed,
                                            (parsed.date || new Date()).toISOString()
                                        ),
                                        attachmentIds: entry.draftId
                                            ? store.get('messages', entry.draftId)?.attachmentIds
                                            : undefined,
                                        conversation: hash(
                                            String(
                                                Array.isArray(parsed.references)
                                                    ? parsed.references[0]
                                                    : parsed.references ||
                                                          parsed.inReplyTo ||
                                                          parsed.messageId ||
                                                          entry.id
                                            )
                                        )
                                    }
                                });
                                changes.push({
                                    collection: 'mailboxes',
                                    id: box.id,
                                    value: {
                                        ...box,
                                        usedBytes:
                                            box.usedBytes +
                                            raw.length -
                                            (entry.draftId
                                                ? store.get('messages', entry.draftId)?.size || 0
                                                : 0)
                                    }
                                });
                            }
                            if (entry.draftId && entry.draftId !== entry.id)
                                changes.push({ collection: 'messages', id: entry.draftId, value: null });
                            return changes;
                        });
                    } catch {
                        await scope.transaction(`retry:${entry.id}:${entry.attempts}`, () => [
                            {
                                collection: 'outbox',
                                id: entry.id,
                                value: {
                                    ...entry,
                                    attempts: entry.attempts + 1,
                                    nextAttempt:
                                        Date.now() +
                                        Math.min(3600000, 30000 * 2 ** Math.min(entry.attempts, 7))
                                }
                            }
                        ]);
                    }
                }
            }
        } finally {
            this.flushing = false;
        }
    }
}
module.exports = { MailService, address };
