'use strict';
const crypto = require('node:crypto');
const { compose, attachments, safeHtml, base64 } = require('./mime');
const { node: n, value } = require('./wbxml');
const { itemClass } = require('./sync-options');
const uid = () => crypto.randomUUID();
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const summary = (m) => ({
    id: m.id,
    folder: m.folder,
    revision: m.revision,
    subject: m.subject || '(No subject)',
    from: m.from || '',
    to: m.to || '',
    date: m.date,
    read: !!m.read,
    starred: !!m.starred || value(m.flag, 'Email:Status') === '2',
    preview: m.preview || '',
    hasAttachments: !!m.hasAttachments,
    conversation: m.conversation || m.id,
    draft: !!m.draft,
    queued: !!m.queued,
    labels: m.labels || [],
    meeting: !!m.meeting
});
class Webmail {
    constructor(mail, auth) {
        this.mail = mail;
        this.auth = auth;
        this.store = mail.store;
        this.scope = this.store.forMailbox(auth.mailbox.id);
    }
    item(id) {
        const item = this.scope.get('messages', id);
        if (!item) throw new Error('Message unavailable');
        return item;
    }
    async list(data) {
        const found = await this.mail.search.mailbox(this.auth, {
            query: data.query || '',
            folder: data.folder || undefined,
            offset: data.offset || 0,
            limit: Math.min(data.limit || 50, 100),
            unread: !!data.unread,
            starred: !!data.starred
        });
        return { total: found.total, items: found.items.map(summary) };
    }
    async overview() {
        const items = this.scope.list('messages');
        return {
            mailbox: this.store.get('mailboxes', this.auth.mailbox.id),
            folders: this.scope.list('folders').map((f) => ({
                ...f,
                class: itemClass(f),
                count: items.filter((m) => m.folder === f.id).length,
                unread: items.filter((m) => m.folder === f.id && !m.read).length
            })),
            preferences: this.scope.get('preferences', 'webmail') || {}
        };
    }
    async read(data) {
        const item = this.item(data.id);
        if (!item.blob) throw new Error('Mail message required');
        const parsed = await this.mail.parse(await this.store.getBlob(item.blob));
        const info = {
            ...summary(item),
            from: parsed.from?.text || '',
            to: parsed.to?.text || '',
            cc: parsed.cc?.text || '',
            bcc:
                item.draft || this.scope.get('folders', item.folder)?.type === 5
                    ? parsed.bcc?.text || ''
                    : undefined,
            replyTo: parsed.replyTo?.text || parsed.from?.text || '',
            text: String(parsed.text || '').slice(0, 512 * 1024),
            bodyTruncated:
                String(parsed.text || '').length > 512 * 1024 ||
                String(parsed.html || '').length > 1024 * 1024,
            html: parsed.html ? safeHtml(parsed.html, parsed.attachments) : '',
            attachments: parsed.attachments.map((a, index) => ({
                index,
                filename: a.filename || 'attachment',
                size: a.size,
                contentType: a.contentType
            })),
            invitation: item.meeting
                ? {
                      ...item.meeting,
                      event: undefined,
                      calendar: (
                          this.scope.get('messages', item.meeting.calendarId) ||
                          this.scope.get('calendarHistory', item.meeting.calendarId)
                      )?.calendar,
                      response: item.meetingResponse
                  }
                : null
        };
        if (!item.read && !data.peek) await this.mutate({ ids: [item.id], action: 'read', value: true });
        return info;
    }
    async attachment(data) {
        const item = this.item(data.id);
        const parsed = await this.mail.parse(await this.store.getBlob(item.blob));
        if (!Number.isInteger(data.index) || !parsed.attachments[data.index])
            throw new Error('Attachment unavailable');
        const file = parsed.attachments[data.index],
            offset = data.offset || 0;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size)
            throw new Error('Invalid attachment offset');
        return {
            base64: file.content.subarray(offset, offset + 384 * 1024).toString('base64'),
            total: file.size,
            filename: file.filename || 'attachment',
            contentType: file.contentType
        };
    }
    async upload(data) {
        const now = Date.now();
        const uploadId = data.id || uid();
        const content = base64(data.base64, 384 * 1024);
        if (
            !/^[\w-]{1,128}$/.test(uploadId) ||
            !Number.isInteger(data.index) ||
            data.index < 0 ||
            data.index > 85
        )
            throw new Error('Invalid upload');
        const blob = await this.store.putBlob(content);
        await this.scope.transaction('upload:' + uid(), (store) => {
            const old = store.get('uploads', uploadId);
            if (old && old.expires < now) throw new Error('Upload expired');
            if (!old && data.index !== 0) throw new Error('Start upload first');
            const chunks = [...(old?.chunks || [])];
            if (data.index > chunks.length) throw new Error('Upload out of order');
            chunks[data.index] = { blob, size: content.length };
            const size = chunks.reduce((s, c) => s + c.size, 0),
                other = store.list('uploads', (u) => u.id !== uploadId && u.expires > now);
            if (
                size > 32 * 1024 * 1024 ||
                other.reduce((s, u) => s + u.size, 0) + size > 64 * 1024 * 1024 ||
                other.length >= 64
            )
                throw new Error('Upload limit exceeded');
            const filename = String(old?.filename || data.filename || 'attachment')
                .replace(/[\x00-\x1f/\\]/g, '_')
                .slice(0, 255);
            return [
                ...store
                    .list('uploads', (u) => u.expires < now)
                    .slice(0, 100)
                    .map((u) => ({ collection: 'uploads', id: u.id, value: null })),
                {
                    collection: 'uploads',
                    id: uploadId,
                    value: {
                        chunks,
                        size,
                        filename,
                        contentType:
                            old?.contentType ||
                            (/^[\w.+-]+\/[\w.+-]+$/.test(data.contentType)
                                ? data.contentType
                                : 'application/octet-stream'),
                        expires: now + 3600000
                    }
                }
            ];
        });
        return { id: uploadId, size: this.scope.get('uploads', uploadId).size };
    }
    async compose(data, previous) {
        if (
            typeof data.subject !== 'string' ||
            data.subject.length > 4096 ||
            typeof data.text !== 'string' ||
            data.text.length > 512 * 1024
        )
            throw new Error('Invalid message');
        for (const key of ['to', 'cc', 'bcc'])
            if (
                data[key] !== undefined &&
                (typeof data[key] !== 'string' || data[key].length > 16000 || /[\r\n]/.test(data[key]))
            )
                throw new Error('Invalid recipients');
        const files = [];
        if (!Array.isArray(data.attachments || []) || (data.attachments || []).length > 100)
            throw new Error('Attachment limit');
        for (const file of data.attachments || []) {
            if (file.upload) {
                const upload = this.scope.get('uploads', file.upload);
                if (!upload || upload.expires < Date.now()) throw new Error('Attachment upload expired');
                files.push({
                    filename: upload.filename,
                    contentType: upload.contentType,
                    content: Buffer.concat(
                        await Promise.all(upload.chunks.map((c) => this.store.getBlob(c.blob)))
                    )
                });
            } else {
                const source = this.item(file.message || previous?.id);
                if (!source.blob) throw new Error('Attachment unavailable');
                const parsed = await this.mail.parse(await this.store.getBlob(source.blob));
                if (!Number.isInteger(file.index) || !parsed.attachments[file.index])
                    throw new Error('Attachment unavailable');
                files.push(attachments(parsed)[file.index]);
            }
        }
        const source = data.source ? this.item(data.source) : null;
        const parsed = source?.blob ? await this.mail.parse(await this.store.getBlob(source.blob)) : null;
        return compose({
            from: this.auth.mailbox.email,
            to: data.to,
            cc: data.cc,
            bcc: data.bcc,
            subject: data.subject,
            text: data.text,
            attachments: files,
            ...(parsed
                ? {
                      inReplyTo: parsed.messageId,
                      references: [
                          ...(Array.isArray(parsed.references)
                              ? parsed.references
                              : parsed.references
                                ? [parsed.references]
                                : []),
                          parsed.messageId
                      ].filter(Boolean)
                  }
                : {})
        });
    }
    async draft(data) {
        const id = data.id || uid(),
            old = this.scope.get('messages', id);
        if (old && (!old.draft || old.queued || old.revision !== data.revision))
            throw new Error('Draft changed; reopen before saving');
        const bytes = await this.compose(data, old),
            blob = await this.store.putBlob(bytes);
        const parsed = await this.mail.parse(bytes);
        const folder = this.scope.list('folders', (f) => f.type === 3)[0];
        await this.scope.transaction('draft:' + uid(), (store) => {
            if (store.get('messages', id)?.revision !== old?.revision) throw new Error('Draft changed');
            const box = store.get('mailboxes', this.auth.mailbox.id),
                usedBytes = box.usedBytes - (old?.size || 0) + bytes.length;
            if (
                usedBytes +
                    store
                        .list('outbox', (o) => o.status === 'pending')
                        .reduce((s, o) => s + (o.reservedBytes ?? o.size), 0) >
                box.quotaBytes
            )
                throw new Error('Mailbox quota exceeded');
            return [
                {
                    collection: 'messages',
                    id,
                    value: {
                        mailbox: box.id,
                        folder: folder.id,
                        blob,
                        size: bytes.length,
                        draft: true,
                        read: true,
                        subject: data.subject,
                        from: box.email,
                        to: data.to || '',
                        date: new Date().toISOString(),
                        preview: data.text.slice(0, 240),
                        hasAttachments: parsed.attachments.length > 0,
                        attachmentIds: parsed.attachments.map((_, index) =>
                            data.attachments?.[index]?.message === id
                                ? old?.attachmentIds?.[data.attachments[index].index] || uid()
                                : uid()
                        ),
                        source: data.source || old?.source
                    }
                },
                { collection: 'mailboxes', id: box.id, value: { ...box, usedBytes } }
            ];
        });
        return this.read({ id, peek: true });
    }
    async send(data) {
        if (typeof data.clientId !== 'string' || !data.clientId || data.clientId.length > 128)
            throw new Error('Submission id required');
        if (
            this.store.operations.has(
                `send:${this.auth.mailbox.id}:${this.auth.device.id}:${hash(data.clientId)}`
            )
        )
            return { queued: true };
        const old = data.id ? this.item(data.id) : null;
        if (old && (!old.draft || old.queued || old.revision !== data.revision))
            throw new Error('Draft changed');
        const bytes = await this.compose(data, old);
        await this.mail.submit(this.auth, bytes, data.clientId, true, (store) => {
            const changes = [];
            if (old) {
                if (store.get('messages', old.id)?.revision !== old.revision)
                    throw new Error('Draft changed');
                const box = store.get('mailboxes', this.auth.mailbox.id);
                changes.push(
                    { collection: 'messages', id: old.id, value: null },
                    {
                        collection: 'mailboxes',
                        id: box.id,
                        value: { ...box, usedBytes: Math.max(0, box.usedBytes - old.size) }
                    }
                );
            }
            if (data.source) {
                const source = store.get('messages', data.source);
                if (!source) throw new Error('Source unavailable');
                changes.push({
                    collection: 'messages',
                    id: source.id,
                    value: { ...source, lastVerb: data.forward ? 3 : 1, lastVerbAt: new Date().toISOString() }
                });
            }
            return changes;
        });
        return { queued: true };
    }
    async mutate(data) {
        if (
            !Array.isArray(data.ids) ||
            !data.ids.length ||
            data.ids.length > 100 ||
            new Set(data.ids).size !== data.ids.length
        )
            throw new Error('Select up to 100 messages');
        if (!['read', 'star', 'move', 'trash', 'delete', 'label'].includes(data.action))
            throw new Error('Invalid action');
        await this.scope.transaction('mail-edit:' + uid(), (store) => {
            const box = store.get('mailboxes', this.auth.mailbox.id);
            let usedBytes = box.usedBytes;
            const changes = [];
            for (const id of data.ids) {
                const m = store.get('messages', id);
                if (!m?.blob || m.queued) throw new Error('Message unavailable');
                let updated = { ...m };
                if (data.action === 'read') updated.read = !!data.value;
                if (data.action === 'star') {
                    updated.starred = !!data.value;
                    updated.flag = n('Email:Flag', n('Email:Status', data.value ? '2' : '0'));
                }
                if (data.action === 'label') {
                    if (
                        !Array.isArray(data.value) ||
                        data.value.length > 20 ||
                        data.value.some((v) => typeof v !== 'string' || v.length > 64)
                    )
                        throw new Error('Invalid labels');
                    updated.labels = data.value;
                    updated.categories = n(
                        'Email:Categories',
                        data.value.map((v) => n('Email:Category', v))
                    );
                }
                if (data.action === 'move' || data.action === 'trash') {
                    const folder =
                        data.action === 'trash'
                            ? store.list('folders', (f) => f.type === 4)[0]
                            : store.get('folders', data.folder);
                    if (!folder || itemClass(folder) !== 'Email' || [3, 6].includes(folder.type))
                        throw new Error('Invalid destination');
                    updated.folder = folder.id;
                }
                if (data.action === 'delete') {
                    updated = null;
                    usedBytes -= m.size || 0;
                }
                changes.push({ collection: 'messages', id, value: updated });
            }
            changes.push({
                collection: 'mailboxes',
                id: box.id,
                value: { ...box, usedBytes: Math.max(0, usedBytes) }
            });
            return changes;
        });
        return { updated: true };
    }
    async folder(data) {
        const id = data.id || uid();
        await this.scope.transaction('web-folder:' + uid(), (store) => {
            const old = store.get('folders', id);
            if (data.id && (!old || old.type < 12)) throw new Error('System folder cannot be edited');
            if (data.remove) {
                if (
                    store.list('messages', (m) => m.folder === id).length ||
                    store.list('folders', (f) => f.parent === id).length
                )
                    throw new Error('Empty the folder before removing it');
                return [{ collection: 'folders', id, value: null }];
            }
            const name = String(data.name || '').trim();
            if (
                !name ||
                name.length > 255 ||
                store.list('folders', (f) => f.id !== id && f.name.toLowerCase() === name.toLowerCase())
                    .length
            )
                throw new Error('Folder name required and must be unique');
            return [
                {
                    collection: 'folders',
                    id,
                    value: { mailbox: this.auth.mailbox.id, parent: '0', type: old?.type || 12, name }
                }
            ];
        });
        return { id };
    }
    async contacts(data) {
        if (!data.action)
            return {
                items: this.scope
                    .list('messages', (m) => m.applicationData?.some((c) => c.name.startsWith('Contacts:')))
                    .map((m) => {
                        const r = n('AirSync:ApplicationData', m.applicationData);
                        return {
                            id: m.id,
                            revision: m.revision,
                            firstName: value(r, 'Contacts:FirstName'),
                            lastName: value(r, 'Contacts:LastName'),
                            email: value(r, 'Contacts:Email1Address'),
                            phone: value(r, 'Contacts:MobilePhoneNumber'),
                            company: value(r, 'Contacts:CompanyName')
                        };
                    })
            };
        const id = data.id || uid();
        const fields = {
            FirstName: data.firstName || '',
            LastName: data.lastName || '',
            Email1Address: data.email || '',
            MobilePhoneNumber: data.phone || '',
            CompanyName: data.company || ''
        };
        if (data.email) require('./mail').address(data.email);
        const applicationData = Object.entries(fields).map(([k, v]) => n('Contacts:' + k, String(v)));
        require('./classes').validate('Contacts', applicationData);
        await this.scope.transaction('contact:' + uid(), (store) => {
            const old = store.get('messages', id);
            if (
                data.id &&
                (!old?.applicationData?.some((c) => c.name.startsWith('Contacts:')) ||
                    old.revision !== data.revision)
            )
                throw new Error('Contact changed');
            const folder = store.list('folders', (f) => f.type === 9)[0];
            return [
                {
                    collection: 'messages',
                    id,
                    value:
                        data.action === 'delete'
                            ? null
                            : {
                                  ...old,
                                  mailbox: this.auth.mailbox.id,
                                  folder: folder.id,
                                  applicationData,
                                  date: new Date().toISOString(),
                                  size: 0
                              }
                }
            ];
        });
        return { id };
    }
    async preferences(data) {
        const timeZone = String(data.timeZone || 'UTC');
        new Intl.DateTimeFormat('en', { timeZone }).format(new Date());
        const appearance =
            data.appearance ?? this.scope.get('preferences', 'webmail')?.appearance ?? 'system';
        if (!['system', 'light', 'dark'].includes(appearance)) throw new Error('Invalid appearance');
        const value = {
            timeZone,
            appearance,
            signature: String(data.signature || '').slice(0, 8000),
            density: data.density === 'compact' ? 'compact' : 'comfortable'
        };
        await this.scope.transaction('preferences:' + uid(), () => [
            { collection: 'preferences', id: 'webmail', value }
        ]);
        return value;
    }
    async handle(handle, data) {
        const allowed = [
            'overview',
            'list',
            'read',
            'attachment',
            'upload',
            'draft',
            'send',
            'mutate',
            'folder',
            'contacts',
            'preferences'
        ];
        if (allowed.includes(handle)) return this[handle](data);
        if (handle === 'raw') {
            const item = this.item(data.id);
            if (!item.blob) throw new Error('Mail message required');
            const bytes = await this.store.getBlob(item.blob),
                offset = data.offset || 0;
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length)
                throw new Error('Invalid download offset');
            return {
                base64: bytes.subarray(offset, offset + 384 * 1024).toString('base64'),
                total: bytes.length
            };
        }
        if (handle === 'thread') {
            const item = this.item(data.id);
            return {
                items: this.scope
                    .list('messages', (m) => m.blob && m.conversation && m.conversation === item.conversation)
                    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
                    .slice(-100)
                    .map(summary)
            };
        }
        if (handle === 'recipients')
            return { items: await this.mail.search.recipients(this.auth, String(data.query || '')) };
        if (handle === 'calendarList')
            return {
                items: this.mail.calendar
                    .list(this.auth, data.from, data.to)
                    .map(
                        ({
                            id,
                            revision,
                            uid,
                            subject,
                            start,
                            end,
                            allDay,
                            busy,
                            instance,
                            organizer,
                            location,
                            status
                        }) => ({
                            id,
                            revision,
                            uid,
                            subject,
                            start,
                            end,
                            allDay,
                            busy,
                            instance,
                            organizer,
                            location,
                            status
                        })
                    )
            };
        if (handle === 'calendarGet') {
            const item = this.item(data.id);
            if (!item.calendar) throw new Error('Calendar event unavailable');
            const tz = require('./timezone'),
                event = item.calendar;
            const wall = (value) => tz.wallTime(Date.parse(value), event.timeZone, event.timezone);
            return {
                ...item,
                wallStart: wall(event.start),
                wallEnd: wall(event.end),
                proposalWallTimes: Object.fromEntries(
                    Object.entries(event.proposals || {}).map(([email, proposal]) => [
                        email,
                        { start: wall(proposal.start), end: wall(proposal.end) }
                    ])
                )
            };
        }
        if (handle === 'calendarSave') {
            const input = { ...data };
            // Read the original rule from this mailbox; the display label is not an IANA zone.
            if (input.keepNativeZone) {
                const original = this.item(input.id).calendar;
                if (!original?.timezone) throw new Error('Original device time zone unavailable');
                input.timezone = original.timezone;
                input.timeZone = original.timeZone || 'UTC';
            }
            if (input.localStart && input.localEnd) {
                const tz = require('./timezone');
                input.start = new Date(
                    tz.fromWall(input.localStart, input.timeZone || 'UTC', input.timezone)
                ).toISOString();
                input.end = new Date(
                    tz.fromWall(input.localEnd, input.timeZone || 'UTC', input.timezone)
                ).toISOString();
            }
            return this.mail.calendar.save(this.auth, input);
        }
        if (handle === 'calendarDeclineProposal')
            return this.mail.calendar.declineProposal(this.auth, data.id, data.email, data.revision);
        if (handle === 'calendarCancel')
            return this.mail.calendar.cancel(this.auth, data.id, data.revision, data.instance);
        if (handle === 'calendarRespond')
            return this.mail.calendar.respond(this.auth, data.id, data.response, {
                body: data.body,
                instance: data.instance,
                proposedStart: data.proposedStart,
                proposedEnd: data.proposedEnd
            });
        throw new Error('Unknown mail operation');
    }
}
module.exports = { Webmail, summary };
