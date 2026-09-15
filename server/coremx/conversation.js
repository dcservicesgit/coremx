'use strict';
const crypto = require('node:crypto');
const filetime = (date) => BigInt(Math.max(0, Date.parse(date) || 0) + 11644473600000) * 10000n;
function header(date) {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(filetime(date));
    return bytes.subarray(0, 5);
}
// MS-ASCON 2.2.2.4: EAS omits the reserved byte and GUID from the MIME Thread-Index.
function index(scope, parsed, date) {
    const supplied = parsed.headers?.get('thread-index');
    if (typeof supplied === 'string' && supplied.length <= 2048 && /^[A-Za-z0-9+/]+={0,2}$/.test(supplied)) {
        const bytes = Buffer.from(supplied, 'base64');
        if (bytes[0] === 1 && bytes.length >= 22 && (bytes.length - 22) % 5 === 0)
            return Buffer.concat([bytes.subarray(1, 6), bytes.subarray(22)]).toString('base64');
    }
    const refs = Array.isArray(parsed.references) ? parsed.references : [parsed.references];
    const parentId = parsed.inReplyTo || refs.at(-1);
    const parent = parentId && scope.list('messages', (m) => m.messageId === parentId)[0];
    if (!parent) return header(date).toString('base64');
    const prior = parent.conversationIndex
        ? Buffer.from(parent.conversationIndex, 'base64')
        : header(parent.date);
    if (!prior.length || prior.length % 5 || prior.length >= 1000) return header(date).toString('base64');
    const root = BigInt(prior.readUIntBE(0, 5)) << 24n;
    const difference = filetime(date) > root ? filetime(date) - root : 0n;
    const large = ((difference >> 32n) & 0x00fe0000n) !== 0n;
    const level = Buffer.alloc(5);
    level.writeUInt32BE(Number((difference >> (large ? 23n : 18n)) & 0x7fffffffn) + (large ? 0x80000000 : 0));
    level[4] = crypto
        .createHash('sha256')
        .update(parsed.messageId || String(date))
        .digest()[0];
    return Buffer.concat([prior, level]).toString('base64');
}
module.exports = { header, index };
