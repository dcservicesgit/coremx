'use strict';
const { node: n, child, children, value } = require('./wbxml');
const { compose, attachments, base64 } = require('./mime');
exports.eas = async (eas, auth, previous, data, folder, id, sendCommand) => {
    const root = n('AirSync:ApplicationData', data);
    const attachmentRoot = child(root, 'AirSyncBase:Attachments');
    if (attachmentRoot) {
        require('./classes').tree(attachmentRoot);
        require('./class-schema').validate(attachmentRoot);
    }
    const allowed = new Set(
        'Email:To Email:Cc Email:From Email:ReplyTo Email:Subject Email:Importance Email:Read Email:Categories Email:Flag Email2:Bcc Email2:IsDraft Email2:Send AirSyncBase:Body AirSyncBase:Attachments'.split(
            ' '
        )
    );
    if (
        data.some((c) => !allowed.has(c.name)) ||
        new Set(data.map((c) => c.name)).size !== data.length ||
        previous?.queued
    )
        throw new Error('Invalid draft');
    if (value(root, 'Email2:IsDraft', '1') !== '1') throw new Error('Draft required');
    const parsed = previous?.blob ? await eas.mail.parse(await eas.store.getBlob(previous.blob)) : {};
    const body = child(root, 'AirSyncBase:Body'),
        type = value(body, 'AirSyncBase:Type', '1');
    if (!['1', '2'].includes(type)) throw new Error('Invalid body');
    let files = attachments(parsed);
    const fileIds = files.map(
        (_, index) => previous?.attachmentIds?.[index] || require('node:crypto').randomUUID()
    );
    const added = [];
    const seen = new Set();
    for (const operation of child(root, 'AirSyncBase:Attachments')?.children || []) {
        if (operation.name === 'AirSyncBase:Delete') {
            const reference = value(operation, 'AirSyncBase:FileReference');
            const index = fileIds.findIndex(
                (fileId, i) => reference === id + ':d:' + fileId || reference === id + ':' + i
            );
            if (index < 0 || !files[index]) throw new Error('Invalid attachment');
            files[index] = null;
        } else if (operation.name === 'AirSyncBase:Add') {
            const clientId = value(operation, 'AirSyncBase:ClientId');
            if (!clientId || clientId.length > 128 || seen.has(clientId))
                throw new Error('Attachment client ID required');
            seen.add(clientId);
            added.push({ clientId, index: files.length });
            const content = child(operation, 'AirSyncBase:Content')?.children?.[0];
            fileIds.push(require('node:crypto').randomUUID());
            files.push({
                filename: value(operation, 'AirSyncBase:DisplayName', 'attachment'),
                content: Buffer.isBuffer(content) ? content : base64(content || ''),
                contentType: value(operation, 'AirSyncBase:ContentType', 'application/octet-stream'),
                cid: value(operation, 'AirSyncBase:ContentId') || undefined
            });
        } else throw new Error('Invalid attachment operation');
    }
    const bytes = await compose({
        from: auth.mailbox.email,
        to: value(root, 'Email:To', parsed.to?.text),
        cc: value(root, 'Email:Cc', parsed.cc?.text),
        bcc: value(root, 'Email2:Bcc', parsed.bcc?.text),
        subject: value(root, 'Email:Subject', parsed.subject || ''),
        ...(body
            ? type === '2'
                ? { html: value(body, 'AirSyncBase:Data') }
                : { text: value(body, 'AirSyncBase:Data') }
            : { text: parsed.text, html: parsed.html || undefined }),
        attachments: files.filter(Boolean),
        messageId: parsed.messageId
    });
    const send = !!sendCommand || (!!child(root, 'Email2:Send') && value(root, 'Email2:Send', '1') !== '0');
    if (send) await eas.mail.envelope(bytes, auth.mailbox);
    const result = await eas.mail.parse(bytes);
    const attachmentReplies = added.map((a) =>
        n(
            'AirSyncBase:Attachment',
            n('AirSyncBase:ClientId', a.clientId),
            n('AirSyncBase:FileReference', id + ':d:' + fileIds[a.index])
        )
    );
    return {
        ...previous,
        attachmentIds: fileIds.filter((_, index) => files[index]),
        attachmentReplies,
        mailbox: auth.mailbox.id,
        folder,
        draft: true,
        send,
        blob: await eas.store.putBlob(bytes),
        size: bytes.length,
        date: new Date().toISOString(),
        read: true,
        subject: result.subject || '',
        from: auth.mailbox.email,
        to: result.to?.text || '',
        preview: String(result.text || '').slice(0, 240),
        hasAttachments: result.attachments.length > 0
    };
};
