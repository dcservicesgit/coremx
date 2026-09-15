'use strict';
const central = require('./central');
const MailComposer = central('node_modules/nodemailer/lib/mail-composer');
const sanitize = central('node_modules/sanitize-html');
const { LIMIT } = require('./store');
function base64(text, limit = LIMIT) {
    if (
        typeof text !== 'string' ||
        text.length > Math.ceil(limit / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
    )
        throw new Error('Invalid attachment encoding');
    const bytes = Buffer.from(text, 'base64');
    if (bytes.length > limit) throw new Error('Attachment too large');
    return bytes;
}
function attachments(parsed) {
    return (parsed.attachments || []).map((a) => ({
        filename: a.filename || 'attachment',
        content: a.content,
        contentType: a.contentType,
        contentDisposition: a.contentDisposition,
        cid: a.cid
    }));
}
async function compose(options) {
    // Never allow nodemailer to dereference caller-controlled URLs or local paths.
    const message = { ...options, disableFileAccess: true, disableUrlAccess: true };
    message.attachments = (options.attachments || []).map((a) => ({
        filename: String(a.filename || 'attachment')
            .replace(/[\r\n]/g, '')
            .slice(0, 255),
        content: Buffer.isBuffer(a.content) ? a.content : base64(a.content || ''),
        contentType: a.contentType || 'application/octet-stream',
        contentDisposition: a.contentDisposition || 'attachment',
        cid: a.cid
    }));
    const compiled = new MailComposer(message).compile();
    compiled.keepBcc = true;
    const bytes = await compiled.build();
    if (bytes.length > LIMIT) throw new Error('Message size limit');
    return bytes;
}
function safeHtml(html, parsedAttachments = []) {
    const inline = new Map();
    let inlineBytes = 0;
    for (const attachment of parsedAttachments) {
        if (
            !attachment.cid ||
            !/^image\/(png|jpeg|gif|webp)$/i.test(attachment.contentType) ||
            attachment.content.length > 1024 * 1024 ||
            inlineBytes + attachment.content.length > 2 * 1024 * 1024
        )
            continue;
        inlineBytes += attachment.content.length;
        inline.set(
            attachment.cid,
            `data:${attachment.contentType};base64,${attachment.content.toString('base64')}`
        );
    }
    let renderedInlineBytes = 0;
    return sanitize(String(html || '').slice(0, 1024 * 1024), {
        allowedTags: [...sanitize.defaults.allowedTags, 'img', 'h1', 'h2', 'span'],
        allowedAttributes: {
            a: ['href', 'target', 'rel'],
            img: ['src', 'alt', 'width', 'height'],
            '*': ['style'],
            td: ['colspan', 'rowspan'],
            th: ['colspan', 'rowspan']
        },
        allowedSchemes: ['https', 'http', 'mailto'],
        allowedSchemesByTag: { img: ['data'] },
        allowProtocolRelative: false,
        allowedStyles: {
            '*': {
                color: [/^#[0-9a-f]{3,8}$/i, /^[a-z]+$/i],
                'background-color': [/^#[0-9a-f]{3,8}$/i],
                'font-weight': [/^(bold|normal|[1-9]00)$/],
                'text-align': [/^(left|right|center|justify)$/],
                'font-size': [/^\d{1,2}(px|pt)$/]
            }
        },
        transformTags: {
            a: (tagName, attrs) => ({
                tagName,
                attribs: { ...attrs, target: '_blank', rel: 'noopener noreferrer' }
            }),
            img: (tagName, attrs) => {
                let src = attrs.src?.startsWith('cid:') ? inline.get(attrs.src.slice(4)) || '' : '';
                if (renderedInlineBytes + src.length > 4 * 1024 * 1024) src = '';
                renderedInlineBytes += src.length;
                return { tagName, attribs: { ...attrs, src, alt: attrs.alt || 'Image blocked' } };
            }
        }
    });
}
function withoutBlindCopies(bytes) {
    let end = bytes.indexOf('\r\n\r\n');
    if (end < 0) end = bytes.indexOf('\n\n');
    if (end < 0) return bytes;
    const header = bytes.subarray(0, end).toString('latin1');
    if (!/^(?:Resent-)?Bcc:/im.test(header)) return bytes;
    let skip = false;
    const kept = [];
    for (const line of header.match(/[^\n]*\n|[^\n]+$/g) || []) {
        if (!/^[ \t]/.test(line)) skip = /^(?:Resent-)?Bcc:/i.test(line);
        if (!skip) kept.push(line);
    }
    return Buffer.concat([Buffer.from(kept.join('').replace(/\r?\n$/, ''), 'latin1'), bytes.subarray(end)]);
}
module.exports = { withoutBlindCopies, compose, attachments, safeHtml, base64 };
