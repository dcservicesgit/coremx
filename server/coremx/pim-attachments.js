'use strict';
const crypto = require('node:crypto');
const { node: n, child, value } = require('./wbxml');
const { base64 } = require('./mime');
exports.update = async (store, previous, root, id) => {
    const files = [...(previous || [])],
        replies = [];
    const seen = new Set();
    for (const operation of root?.children || []) {
        if (operation.name === 'AirSyncBase:Delete') {
            const reference = value(operation, 'AirSyncBase:FileReference'),
                index = files.findIndex((f) => `${id}:a:${f.id}` === reference);
            if (index < 0) throw new Error('Attachment unavailable');
            files.splice(index, 1);
        } else if (operation.name === 'AirSyncBase:Add') {
            const clientId = value(operation, 'AirSyncBase:ClientId');
            if (!clientId || clientId.length > 128 || seen.has(clientId))
                throw new Error('Attachment client ID required');
            seen.add(clientId);
            if (value(operation, 'AirSyncBase:Method', '1') !== '1')
                throw new Error('Unsupported attachment method');
            const content = child(operation, 'AirSyncBase:Content')?.children?.[0];
            const bytes = Buffer.isBuffer(content) ? content : base64(content || '');
            if (bytes.length > 24 * 1024 * 1024) throw new Error('Attachment size limit');
            const file = {
                id: crypto.randomUUID(),
                filename: value(operation, 'AirSyncBase:DisplayName', 'attachment').slice(0, 255),
                contentType: value(operation, 'AirSyncBase:ContentType', 'application/octet-stream'),
                cid: value(operation, 'AirSyncBase:ContentId'),
                blob: await store.putBlob(bytes),
                size: bytes.length
            };
            files.push(file);
            replies.push(
                n(
                    'AirSyncBase:Attachment',
                    n('AirSyncBase:ClientId', clientId),
                    n('AirSyncBase:FileReference', `${id}:a:${file.id}`)
                )
            );
        } else throw new Error('Invalid attachment operation');
    }
    if (files.length > 100 || files.reduce((s, f) => s + f.size, 0) > 32 * 1024 * 1024)
        throw new Error('Attachment limit');
    return { files, replies };
};
exports.data = (files, id) =>
    n(
        'AirSyncBase:Attachments',
        (files || []).map((f) =>
            n(
                'AirSyncBase:Attachment',
                n('AirSyncBase:DisplayName', f.filename),
                n('AirSyncBase:FileReference', `${id}:a:${f.id}`),
                n('AirSyncBase:Method', '1'),
                n('AirSyncBase:EstimatedDataSize', String(f.size))
            )
        )
    );
