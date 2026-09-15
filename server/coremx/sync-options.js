'use strict';
const { node: n, child, children, value } = require('./wbxml');
const { LIMIT } = require('./store');
const field = (name, data) => n(name, String(data));
const itemClass = (folder) =>
    ({
        7: 'Tasks',
        8: 'Calendar',
        9: 'Contacts',
        10: 'Notes',
        13: 'Calendar',
        14: 'Contacts',
        15: 'Tasks',
        17: 'Notes'
    })[folder.type] || 'Email';
function integer(root, name, fallback, max = 0xffffffff) {
    const text = value(root, name, String(fallback));
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) > max)
        throw new Error('Invalid ' + name);
    return Number(text);
}
function boolean(root, name, fallback = false) {
    if (!child(root, name)) return fallback;
    const text = value(root, name);
    if (!['', '0', '1'].includes(text)) throw new Error('Invalid ' + name);
    return text !== '0';
}
function bodyOptions(root) {
    const preferences = children(root, 'AirSyncBase:BodyPreference').map((p) => {
        const type = integer(p, 'AirSyncBase:Type', 1, 4);
        if (!type) throw new Error('Invalid body type');
        return {
            type,
            size: child(p, 'AirSyncBase:TruncationSize') ? integer(p, 'AirSyncBase:TruncationSize', 0) : null,
            all: boolean(p, 'AirSyncBase:AllOrNone'),
            preview: integer(p, 'AirSyncBase:Preview', 0, 255)
        };
    });
    if (new Set(preferences.map((p) => p.type)).size !== preferences.length)
        throw new Error('Repeated body type');
    const partRoot = child(root, 'AirSyncBase:BodyPartPreference');
    let part;
    if (partRoot) {
        if (value(partRoot, 'AirSyncBase:Type') !== '2')
            throw Object.assign(new Error('Body part requires HTML'), { easStatus: 164 });
        part = {
            type: 2,
            size: child(partRoot, 'AirSyncBase:TruncationSize')
                ? integer(partRoot, 'AirSyncBase:TruncationSize', 0)
                : null,
            all: boolean(partRoot, 'AirSyncBase:AllOrNone'),
            preview: integer(partRoot, 'AirSyncBase:Preview', 0, 255)
        };
    }
    return {
        preferences,
        part,
        mime: integer(root, 'AirSync:MIMESupport', 0, 2),
        mimeTruncation: integer(root, 'AirSync:MIMETruncation', 8, 8)
    };
}
function syncOptions(collection, folder, previous) {
    const roots = children(collection, 'AirSync:Options');
    if (roots.length > 1) throw new Error('Multiple classes unsupported');
    if (!roots.length && previous)
        return {
            ...previous,
            conversation: boolean(collection, 'AirSync:ConversationMode', previous.conversation)
        };
    const root = roots[0];
    const type = itemClass(folder);
    if (value(root, 'AirSync:Class', type) !== type) throw new Error('Folder class mismatch');
    let filter = integer(root, 'AirSync:FilterType', 0, 8);
    if (type === 'Contacts') filter = 0;
    const allowed = {
        Email: [0, 1, 2, 3, 4, 5],
        Calendar: [0, 4, 5, 6, 7],
        Tasks: [0, 8],
        Contacts: [0],
        Notes: [0]
    }[type];
    if (!allowed.includes(filter)) throw new Error('Invalid filter for class');
    if (child(collection, 'AirSync:ConversationMode') && type !== 'Email')
        throw new Error('Conversation mode requires email');
    return {
        ...bodyOptions(root),
        filter,
        conversation: boolean(collection, 'AirSync:ConversationMode'),
        conflict: integer(root, 'AirSync:Conflict', 1, 1)
    };
}
function timestamp(text) {
    // Calendar uses compact UTC dates; email uses extended ISO dates.
    return Date.parse(
        String(text).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')
    );
}
function matches(item, folder, options = {}, now = Date.now()) {
    const filter = options.filter || 0;
    if (!filter) return true;
    const type = itemClass(folder);
    const data = n('AirSync:ApplicationData', item.applicationData || []);
    if (type === 'Tasks') return value(data, 'Tasks:Complete', '0') !== '1';
    const cutoff = new Date(now);
    if (filter <= 4) cutoff.setUTCDate(cutoff.getUTCDate() - { 1: 1, 2: 3, 3: 7, 4: 14 }[filter]);
    else cutoff.setUTCMonth(cutoff.getUTCMonth() - { 5: 1, 6: 3, 7: 6 }[filter]);
    if (type === 'Calendar') {
        if (item.calendar) return require('./calendar-codec').occursAfter(item.calendar, cutoff.getTime());
        if (child(data, 'Calendar:Recurrence'))
            return require('./calendar-codec').occursAfter(
                require('./calendar-codec').fromEas(data.children),
                cutoff.getTime()
            );
        return (
            timestamp(value(data, 'Calendar:EndTime', value(data, 'Calendar:StartTime'))) >= cutoff.getTime()
        );
    }
    const date = timestamp(item.date);
    return date >= cutoff.getTime() && date <= now;
}
function delta(scope, folder, snapshot = {}, options, now) {
    const items = scope.list('messages', (item) => item.folder === folder.id);
    const live = new Map(items.map((item) => [item.id, item]));
    let selected = items.filter((item) => matches(item, folder, options, now));
    const normalIds = new Set(selected.map((item) => item.id));
    if (options?.conversation) {
        const conversations = new Set(selected.map((item) => item.conversation).filter(Boolean));
        selected = items.filter((item) => normalIds.has(item.id) || conversations.has(item.conversation));
    }
    const selectedIds = new Set(selected.map((item) => item.id));
    return [
        ...selected
            .filter((item) => snapshot[item.id] !== item.revision)
            .map((item) => ({ item, metadataOnly: options?.conversation && !normalIds.has(item.id) })),
        ...Object.keys(snapshot)
            .filter((id) => !selectedIds.has(id))
            .map((id) => ({ id, soft: live.has(id) }))
    ];
}
function utf8Prefix(text, length) {
    const bytes = Buffer.from(text);
    let end = Math.min(bytes.length, length);
    while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end).toString('utf8');
}
function bodyData(parsed, raw, options = {}, maxBytes = LIMIT) {
    const plain = (parsed.text || '').replace(/\0/g, '');
    const html = typeof parsed.html === 'string' ? parsed.html.replace(/\0/g, '') : null;
    const smime = /(?:application\/(?:x-)?pkcs7-mime|multipart\/signed)/i.test(
        String(parsed.headers.get('content-type')?.value || '')
    );
    const available = new Map([
        [1, plain],
        ...(html ? [[2, html]] : []),
        ...(options.mime === 2 || (options.mime === 1 && smime) ? [[4, raw]] : [])
    ]);
    const preferences = options.preferences?.length
        ? [...options.preferences]
        : [{ type: 1, size: 4096, preview: 0 }];
    // Prefer the stored representation; then try the client's alternatives.
    const native = html ? 2 : 1;
    preferences.sort((a, b) => (b.type === native) - (a.type === native));
    if (options.mime && preferences.some((p) => p.type === 4))
        preferences.sort((a, b) => (b.type === 4) - (a.type === 4));
    let chosen, data, size;
    for (const preference of preferences) {
        if (!available.has(preference.type)) continue;
        const candidate = available.get(preference.type);
        const length = Buffer.byteLength(candidate);
        const mimeLimit =
            preference.type === 4
                ? [0, 512, 1024, 2048, 5120, 10240, 20480, 51200, LIMIT][options.mimeTruncation ?? 8]
                : LIMIT;
        const limit = Math.min(preference.size ?? LIMIT, maxBytes, mimeLimit);
        if (preference.all && preference.size !== null && length > limit) continue;
        chosen = preference;
        size = length;
        data = Buffer.isBuffer(candidate) ? candidate.subarray(0, limit) : utf8Prefix(candidate, limit);
        break;
    }
    if (!chosen) {
        chosen = { type: 1, preview: 0 };
        size = Buffer.byteLength(plain);
        data = '';
    }
    const length = Buffer.byteLength(data);
    return [
        n(
            'AirSyncBase:Body',
            field('AirSyncBase:Type', chosen.type),
            field('AirSyncBase:EstimatedDataSize', size),
            field('AirSyncBase:Truncated', length < size ? 1 : 0),
            n('AirSyncBase:Data', data),
            chosen.preview
                ? field('AirSyncBase:Preview', Array.from(plain).slice(0, chosen.preview).join(''))
                : null
        ),
        field('AirSyncBase:NativeBodyType', native)
    ];
}
module.exports = {
    utf8Prefix,
    itemClass,
    integer,
    boolean,
    bodyOptions,
    syncOptions,
    matches,
    delta,
    bodyData
};
