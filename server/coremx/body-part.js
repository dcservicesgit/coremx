'use strict';
const { node: n } = require('./wbxml');
const { utf8Prefix } = require('./sync-options');
const f = (key, value) => n('AirSyncBase:' + key, String(value));
module.exports = async (eas, message, parsed, options, maxBytes = 32 * 1024 * 1024) => {
    const preference = options.part,
        scope = eas.store.forMailbox(message.mailbox);
    const conversation = scope.list(
        'messages',
        (m) => m.conversation && m.conversation === message.conversation
    );
    if (
        conversation.length > 100 ||
        conversation.reduce((sum, m) => sum + (m.size || 0), 0) > 32 * 1024 * 1024
    )
        return n('AirSyncBase:BodyPart', f('Status', 176), f('Type', 2), f('EstimatedDataSize', 0));
    let text = (parsed.text || '').replace(/\r\n/g, '\n');
    const parent = scope.list('messages', (m) => m.messageId && m.messageId === parsed.inReplyTo)[0];
    if (parent?.blob) {
        const previous = await eas.mail.parse(await eas.store.getBlob(parent.blob));
        const original = (previous.text || '').replace(/\r\n/g, '\n').trim();
        if (original) {
            const quoted = original
                .split('\n')
                .map((line) => '> ' + line)
                .join('\n');
            for (const suffix of [quoted, original]) {
                const end = text.trimEnd();
                if (end.endsWith(suffix)) {
                    text = end
                        .slice(0, -suffix.length)
                        .replace(/\nOn [^\n]+wrote:\s*$/, '')
                        .trimEnd();
                    break;
                }
            }
        }
    }
    const html =
        '<div>' +
        text
            .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
            .replace(/\n/g, '<br>') +
        '</div>';
    const size = Buffer.byteLength(html),
        limit = Math.min(preference.size ?? maxBytes, maxBytes),
        data = preference.all && size > limit ? '' : utf8Prefix(html, limit);
    return [
        n(
            'AirSyncBase:BodyPart',
            f('Status', 1),
            f('Type', 2),
            f('EstimatedDataSize', size),
            f('Truncated', Buffer.byteLength(data) < size ? 1 : 0),
            f('Data', data),
            preference.preview ? f('Preview', Array.from(text).slice(0, preference.preview).join('')) : null
        ),
        f('NativeBodyType', parsed.html ? 2 : 1)
    ];
};
