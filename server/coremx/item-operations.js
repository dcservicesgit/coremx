'use strict';
const { node: n, child, value, encode } = require('./wbxml');
const { itemClass, bodyOptions } = require('./sync-options');
const { LIMIT } = require('./store');
const f = (name, text) => n(name, String(text));
const failure = (code) => Object.assign(new Error('ItemOperations failed'), { itemStatus: code });
module.exports = async function itemOperations(eas, root, auth) {
    const scope = eas.store.forMailbox(auth.mailbox.id);
    const responses = [];
    const operations = root.children || [];
    let total = 0;
    if (!operations.length || operations.length > 20)
        return n('ItemOperations:ItemOperations', f('ItemOperations:Status', 11));
    for (const fetch of operations) {
        if (fetch.name !== 'ItemOperations:Fetch')
            return n('ItemOperations:ItemOperations', f('ItemOperations:Status', 2));
        const reference = value(fetch, 'AirSyncBase:FileReference');
        const folderId = value(fetch, 'AirSync:CollectionId');
        const serverId = value(fetch, 'AirSync:ServerId');
        const identity = reference
            ? [f('AirSyncBase:FileReference', reference)]
            : [f('AirSync:CollectionId', folderId), f('AirSync:ServerId', serverId)];
        try {
            if (value(fetch, 'ItemOperations:Store') !== 'Mailbox') throw failure(9);
            const options = child(fetch, 'ItemOperations:Options');
            if (
                options?.children?.some(
                    (c) =>
                        ![
                            'ItemOperations:Schema',
                            'AirSyncBase:BodyPreference',
                            'AirSyncBase:BodyPartPreference',
                            'AirSync:MIMESupport',
                            'AirSync:MIMETruncation',
                            'ItemOperations:Range'
                        ].includes(c.name)
                )
            )
                throw failure(2);
            let properties, type;
            if (reference) {
                if (
                    folderId ||
                    serverId ||
                    !/^[a-zA-Z0-9_-]{1,128}:(?:\d+|[ad]:[a-zA-Z0-9_-]{1,128})$/.test(reference)
                )
                    throw failure(15);
                const [id, index, attachmentId] = reference.split(':');
                const item = scope.get('messages', id);
                if (!item) throw failure(15);
                let attachment;
                if (index === 'a') {
                    const stored = item.pimAttachments?.find((f) => f.id === attachmentId);
                    if (stored) attachment = { ...stored, content: await eas.store.getBlob(stored.blob) };
                } else if (item.blob) {
                    const parsed = await eas.mail.parse(await eas.store.getBlob(item.blob));
                    attachment =
                        parsed.attachments[
                            index === 'd' ? item.attachmentIds?.indexOf(attachmentId) : Number(index)
                        ];
                }
                if (!attachment) throw failure(15);
                const policy = eas.mail.policy.current(auth);
                if (!policy.AttachmentsEnabled || attachment.size > policy.MaxAttachmentSize)
                    throw failure(8);
                // Default inline delivery is base64 text, not a WBXML opaque token.
                let content = attachment.content;
                const range = value(options, 'ItemOperations:Range');
                let rangeFields = [];
                if (range) {
                    const match = /^(\d+)-(\d+)$/.exec(range);
                    if (!match || +match[1] > +match[2] || +match[1] >= content.length) throw failure(12);
                    const end = Math.min(+match[2], content.length - 1);
                    rangeFields = [
                        f('ItemOperations:Range', match[1] + '-' + end),
                        f('ItemOperations:Total', content.length)
                    ];
                    content = content.subarray(+match[1], end + 1);
                }
                properties = [
                    f('AirSyncBase:ContentType', attachment.contentType),
                    ...rangeFields,
                    f('ItemOperations:Data', content.toString('base64'))
                ];
            } else {
                const item = scope.get('messages', serverId);
                const folder = scope.get('folders', folderId);
                if (!folder || !item || item.folder !== folderId) throw failure(150);
                type = itemClass(folder);
                let preferences;
                try {
                    preferences = eas.mail.policy.filterOptions(auth, bodyOptions(options), type);
                } catch (error) {
                    throw failure(error.easStatus || 2);
                }
                properties = (await eas.applicationData(item, preferences, undefined, auth.protocolVersion))
                    .children;
                const schema = child(options, 'ItemOperations:Schema');
                if (schema) {
                    const selected = new Set(schema.children.map((c) => c.name));
                    if (!selected.size || schema.children.some((c) => !c.name || c.children.length))
                        throw failure(2);
                    properties = properties.filter((c) => selected.has(c.name));
                }
            }
            const result = n(
                'ItemOperations:Fetch',
                f('ItemOperations:Status', 1),
                identity,
                type ? f('AirSync:Class', type) : null,
                n('ItemOperations:Properties', properties)
            );
            const size = encode(n('ItemOperations:ItemOperations', result)).length;
            if (total + size > LIMIT - 8192) throw failure(11);
            total += size;
            responses.push(result);
        } catch (error) {
            if (!error.itemStatus) throw error;
            responses.push(n('ItemOperations:Fetch', f('ItemOperations:Status', error.itemStatus), identity));
        }
    }
    return n(
        'ItemOperations:ItemOperations',
        f('ItemOperations:Status', 1),
        n('ItemOperations:Response', responses)
    );
};
// MS-ASCMD 2.2.1.10.1: little-endian count, then offset/length pairs.
module.exports.multipart = function multipart(root) {
    const parts = [];
    function visit(element) {
        if (element.name === 'ItemOperations:Data') {
            parts.push(Buffer.from(element.children.join(''), 'base64'));
            return f('ItemOperations:Part', parts.length);
        }
        if (element.name === 'AirSyncBase:Body') {
            element.children = element.children.map((c) => {
                if (c.name !== 'AirSyncBase:Data') return c;
                parts.push(Buffer.isBuffer(c.children[0]) ? c.children[0] : Buffer.from(c.children.join('')));
                return f('ItemOperations:Part', parts.length);
            });
            return element;
        }
        if (element.children) element.children = element.children.map((c) => (c?.name ? visit(c) : c));
        return element;
    }
    const wbxml = encode(visit(root));
    parts.unshift(wbxml);
    const header = Buffer.alloc(4 + parts.length * 8);
    header.writeUInt32LE(parts.length);
    let offset = header.length;
    for (let index = 0; index < parts.length; index++) {
        header.writeUInt32LE(offset, 4 + index * 8);
        header.writeUInt32LE(parts[index].length, 8 + index * 8);
        offset += parts[index].length;
    }
    return Buffer.concat([header, ...parts]);
};
