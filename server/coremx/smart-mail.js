'use strict';
const { node: n, child, value } = require('./wbxml');
const { compose, attachments } = require('./mime');
const status = (command, code) => n('ComposeMail:' + command, n('ComposeMail:Status', String(code)));
module.exports = async function smartMail(eas, command, root, auth) {
    const submissionId = value(root, 'ComposeMail:ClientId');
    if (
        submissionId &&
        eas.store.operations.has(
            'send:' +
                auth.mailbox.id +
                ':' +
                auth.device.id +
                ':' +
                require('node:crypto').createHash('sha256').update(submissionId).digest('hex')
        )
    )
        return null;
    const source = child(root, 'ComposeMail:Source');
    const scope = eas.store.forMailbox(auth.mailbox.id);
    const long = value(source, 'ComposeMail:LongId');
    const id = long || value(source, 'ComposeMail:ItemId');
    const folder = value(source, 'ComposeMail:FolderId');
    const original = scope.get('messages', id);
    if (!original || (!long && original.folder !== folder)) return status(command, 150);
    if (child(root, 'ComposeMail:Forwardees')) {
        if (command !== 'SmartForward' || auth.protocolVersion === '14.1') return status(command, 138);
        if (['Mime', 'SaveInSentItems', 'ReplaceMime'].some((name) => child(root, 'ComposeMail:' + name)))
            return status(command, 178);
        return eas.mail.calendar.forward(auth, original, root);
    }
    if (!original.blob) return status(command, 150);
    const mime = child(root, 'ComposeMail:Mime')?.children?.[0];
    if (!Buffer.isBuffer(mime)) return status(command, 101);
    const clientId = value(root, 'ComposeMail:ClientId');
    if (!clientId || clientId.length > 128) return status(command, 103);
    let bytes = mime;
    if (!child(root, 'ComposeMail:ReplaceMime')) {
        const [draft, previous] = await Promise.all([
            eas.mail.parse(mime),
            eas.mail.parse(await eas.store.getBlob(original.blob))
        ]);
        const forwarded = command === 'SmartForward';
        const escape = (text) =>
            String(text || '').replace(
                /[&<>"]/g,
                (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
            );
        const html =
            draft.html || previous.html
                ? (draft.html || '<div>' + escape(draft.text).replace(/\n/g, '<br>') + '</div>') +
                  '<br><blockquote>' +
                  (previous.html || '<div>' + escape(previous.text).replace(/\n/g, '<br>') + '</div>') +
                  '</blockquote>'
                : undefined;
        const separator = forwarded
            ? `\n\n---------- Forwarded message ----------\nFrom: ${previous.from?.text || ''}\nDate: ${previous.date?.toISOString() || original.date}\nSubject: ${previous.subject || ''}\nTo: ${previous.to?.text || ''}\n\n`
            : '\n\n' +
              (previous.text || '')
                  .split('\n')
                  .map((line) => '> ' + line)
                  .join('\n');
        bytes = await compose({
            from: draft.from?.value,
            to: draft.to?.value,
            cc: draft.cc?.value,
            bcc: draft.bcc?.value,
            replyTo: draft.replyTo?.value,
            subject: draft.subject || `${forwarded ? 'Fwd' : 'Re'}: ${previous.subject || ''}`,
            text: (draft.text || '') + separator + (forwarded ? previous.text || '' : ''),
            html,
            inReplyTo: forwarded ? undefined : previous.messageId,
            references: [
                ...(Array.isArray(previous.references)
                    ? previous.references
                    : previous.references
                      ? [previous.references]
                      : []),
                ...(previous.messageId ? [previous.messageId] : [])
            ],
            attachments: [
                ...attachments(draft),
                ...attachments(previous).filter(
                    (a) => forwarded || (html && a.cid && a.contentDisposition === 'inline')
                )
            ]
        });
    }
    await eas.mail.submit(auth, bytes, clientId, !!child(root, 'ComposeMail:SaveInSentItems'), (store) => {
        const item = store.get('messages', id);
        if (!item) throw new Error('Source message unavailable');
        return [
            {
                collection: 'messages',
                id,
                value: {
                    ...item,
                    lastVerb: command === 'SmartReply' ? 1 : 3,
                    lastVerbAt: new Date().toISOString()
                }
            }
        ];
    });
    return null;
};
