'use strict';
const crypto = require('node:crypto');
const { node: n, child, children, value, encode, decode } = require('./wbxml');
const { itemClass, integer, boolean, syncOptions, delta } = require('./sync-options');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const f = (name, text) => n('AirSync:' + name, String(text));
const response = (kind, id, status, client = false) =>
    n('AirSync:' + kind, f(client ? 'ClientId' : 'ServerId', id), f('Status', status));
const MAX_RESPONSE = 1024 * 1024;
const textTree = (node) =>
    typeof node === 'string' ||
    (node && typeof node.name === 'string' && Array.isArray(node.children) && node.children.every(textTree));
module.exports = async function sync(eas, root, auth, bytes) {
    const scope = eas.store.forMailbox(auth.mailbox.id);
    const replayId = hash(Buffer.concat([Buffer.from(auth.device.id), bytes]));
    const replay = scope.get('syncReplies', replayId);
    if (replay) return decode(Buffer.from(replay.response, 'base64'));
    if (child(root, 'AirSync:Partial')) return n('AirSync:Sync', f('Status', 13));
    // The request coordinator expands Partial and removes hanging options before this atomic executor.
    if (child(root, 'AirSync:Wait') || child(root, 'AirSync:HeartbeatInterval'))
        return n('AirSync:Sync', f('Status', 4));
    const collections = children(child(root, 'AirSync:Collections'), 'AirSync:Collection');
    if (!collections.length || collections.length > 20) return n('AirSync:Sync', f('Status', 15));
    const folderIds = collections.map((c) => value(c, 'AirSync:CollectionId'));
    if (new Set(folderIds).size !== folderIds.length) return n('AirSync:Sync', f('Status', 4));
    // Serialize the complete mutation/state/retry response in one journal commit.
    // This avoids losing a client Add or acknowledging an item revision never sent.
    await scope.transaction('sync-result:' + replayId, async (store) => {
        if (
            store.get('devices', auth.device.id)?.revoked ||
            !store.get('mailboxes', auth.mailbox.id)?.enabled
        )
            throw new Error('Mailbox device unavailable');
        if (auth.enforcePolicy) {
            const status = eas.mail.policy.check(auth, auth.policyKey, auth.protocolVersion);
            if (status) throw Object.assign(new Error('Policy no longer valid'), { easStatus: status });
        }
        const changes = [],
            results = [];
        let responseBytes = 0;
        const revision = eas.store.sequence + 1;
        const pending = new Map();
        const read = (kind, id) =>
            pending.has(`${kind}:${id}`) ? pending.get(`${kind}:${id}`) : store.get(kind, id);
        const write = (kind, id, data) => {
            const item = data === null ? null : { ...data, id, revision };
            pending.set(`${kind}:${id}`, item);
            changes.push({ collection: kind, id, value: item });
            return item;
        };
        const view = {
            list(kind, predicate) {
                const records = new Map(store.list(kind).map((item) => [item.id, item]));
                for (const [key, item] of pending)
                    if (key.startsWith(kind + ':')) {
                        const id = key.slice(kind.length + 1);
                        if (item) records.set(id, item);
                        else records.delete(id);
                    }
                return [...records.values()].filter(predicate);
            }
        };
        for (const collection of collections) {
            const folderId = value(collection, 'AirSync:CollectionId');
            const folder = store.get('folders', folderId);
            const key = value(collection, 'AirSync:SyncKey');
            const status = (code) =>
                n('AirSync:Collection', f('SyncKey', key), f('CollectionId', folderId), f('Status', code));
            if (!folder || (folder.type === 3 && auth.protocolVersion === '14.1')) {
                results.push(status(12));
                continue;
            }
            const old = key === '0' ? null : store.get('sync', key);
            if (key !== '0' && (!old || old.device !== auth.device.id || old.folder !== folderId)) {
                results.push(status(3));
                continue;
            }
            const commands = child(collection, 'AirSync:Commands')?.children || [];
            let options, getChanges, deletesAsMoves, window;
            try {
                options = eas.mail.policy.filterOptions(
                    auth,
                    syncOptions(collection, folder, old?.options),
                    itemClass(folder)
                );
                window = Math.min(25, integer(collection, 'AirSync:WindowSize', 25));
                if (!window) throw new Error('Invalid window');
                getChanges = boolean(collection, 'AirSync:GetChanges', key !== '0');
                deletesAsMoves = boolean(collection, 'AirSync:DeletesAsMoves', true);
                if ((key === '0' && (commands.length || getChanges)) || commands.length > 100)
                    throw new Error('Invalid commands');
            } catch (error) {
                results.push(status(error.easStatus || 4));
                continue;
            }
            const type = itemClass(folder);
            let supported = old?.supported ?? null;
            if (key === '0' && child(collection, 'AirSync:Supported')) {
                supported = child(collection, 'AirSync:Supported').children.map((c) => c.name);
                const required = ['Calendar:AllDayEvent', 'Calendar:Reminder', 'Calendar:Exceptions'];
                if (
                    !['Contacts', 'Calendar'].includes(type) ||
                    supported.some(
                        (name) =>
                            !name ||
                            ![type, ...(type === 'Contacts' ? ['Contacts2'] : [])].includes(
                                name.split(':')[0]
                            )
                    ) ||
                    (type === 'Calendar' && required.some((name) => !supported.includes(name)))
                ) {
                    results.push(status(4));
                    continue;
                }
            }
            const snapshot = { ...(old?.snapshot || {}) };
            const responses = [];
            const touched = new Set();
            for (const command of commands) {
                const kind = command.name?.split(':')[1];
                const clientId = value(command, 'AirSync:ClientId');
                const id =
                    kind === 'Add'
                        ? hash(auth.device.id + ':' + folderId + ':' + clientId)
                        : value(command, 'AirSync:ServerId');
                if (!['Add', 'Change', 'Delete', 'Fetch'].includes(kind))
                    throw new Error('Unsupported Sync command');
                if (touched.has(id)) {
                    responses.push(response(kind, kind === 'Add' ? clientId : id, 4, kind === 'Add'));
                    continue;
                }
                touched.add(id);
                const item = read('messages', id);
                if (kind !== 'Add' && (!item || item.folder !== folderId)) {
                    responses.push(response(kind, id, 8));
                    continue;
                }
                const instanceText = value(command, 'AirSyncBase:InstanceId');
                if (instanceText && type === 'Calendar' && auth.protocolVersion !== '14.1') {
                    try {
                        const codec = require('./calendar-codec'),
                            instance = require('./timezone').date(instanceText).toISOString();
                        if (
                            !item.calendar ||
                            !codec.hasInstance(item.calendar, instance) ||
                            !['Change', 'Delete'].includes(kind)
                        )
                            throw new Error('Invalid instance');
                        const occurrence = codec
                            .occurrences(
                                item.calendar,
                                new Date(Date.parse(instance) - 1).toISOString(),
                                new Date(Date.parse(instance) + 366 * 86400000).toISOString()
                            )
                            .find((e) => e.instance === instance);
                        if (!occurrence) throw new Error('Instance unavailable');
                        let exception = { instance, deleted: kind === 'Delete' };
                        if (kind === 'Change') {
                            const supplied = child(command, 'AirSync:ApplicationData')?.children;
                            if (!supplied) throw new Error('Missing data');
                            const normalized = require('./classes').validate('Calendar', supplied, {
                                previous: { ...occurrence, rrule: null, exceptions: [] },
                                version: auth.protocolVersion
                            }).calendar;
                            exception = {
                                ...normalized,
                                instance,
                                rrule: undefined,
                                exceptions: undefined,
                                deleted: false
                            };
                        }
                        const updated = {
                            ...item,
                            calendar: {
                                ...item.calendar,
                                ics: undefined,
                                exceptions: [
                                    ...item.calendar.exceptions.filter((e) => e.instance !== instance),
                                    exception
                                ]
                            }
                        };
                        const queued = await require('./calendar-sync')(
                            eas,
                            auth,
                            item,
                            updated,
                            kind === 'Delete',
                            instance
                        );
                        for (const entry of queued) write('outbox', entry.id, entry);
                        write('messages', id, updated);
                        snapshot[id] = revision;
                        responses.push(
                            n(
                                'AirSync:' + kind,
                                f('ServerId', id),
                                n('AirSyncBase:InstanceId', instanceText),
                                f('Status', 1)
                            )
                        );
                    } catch {
                        responses.push(response(kind, id, 6));
                    }
                    continue;
                }
                if (item?.queued && ['Change', 'Delete'].includes(kind)) {
                    responses.push(response(kind, id, 7));
                    continue;
                }
                if (kind === 'Fetch') {
                    const data = await eas.applicationData(item, options, 128 * 1024, auth.protocolVersion);
                    responses.push(n('AirSync:Fetch', f('ServerId', id), f('Status', 1), data));
                    continue;
                }
                if (
                    kind === 'Add' &&
                    ((type === 'Email' && folder.type !== 3) || !clientId || clientId.length > 128)
                ) {
                    responses.push(response(kind, clientId, 6, true));
                    continue;
                }
                if (kind === 'Add' && item) {
                    responses.push(
                        n('AirSync:Add', f('ClientId', clientId), f('ServerId', id), f('Status', 1))
                    );
                    snapshot[id] = item.revision;
                    continue;
                }
                if (kind === 'Change' && options.conflict === 1 && old.snapshot[id] !== item.revision) {
                    responses.push(response(kind, id, 7));
                    continue;
                }
                if (kind === 'Delete') {
                    if (type === 'Calendar') {
                        const queued = await require('./calendar-sync')(eas, auth, item, null, true);
                        for (const entry of queued) write('outbox', entry.id, entry);
                    }
                    const trash = type === 'Email' && store.list('folders', (folder) => folder.type === 4)[0];
                    if (trash && item.folder !== trash.id && deletesAsMoves)
                        write('messages', id, { ...item, folder: trash.id });
                    else {
                        write('messages', id, null);
                        if (item.size) {
                            const box = read('mailboxes', auth.mailbox.id);
                            write('mailboxes', box.id, {
                                ...box,
                                usedBytes: Math.max(0, box.usedBytes - item.size)
                            });
                        }
                    }
                    delete snapshot[id];
                    continue;
                }
                const data = child(command, 'AirSync:ApplicationData')?.children;
                if (
                    !Array.isArray(data) ||
                    Buffer.byteLength(
                        JSON.stringify(data.filter((c) => c.name !== 'AirSyncBase:Attachments'))
                    ) >
                        256 * 1024 ||
                    data.some(
                        (c) =>
                            !c.name ||
                            (!textTree(c) &&
                                !(auth.protocolVersion !== '14.1' && c.name === 'AirSyncBase:Attachments'))
                    )
                ) {
                    responses.push(response(kind, kind === 'Add' ? clientId : id, 6, kind === 'Add'));
                    continue;
                }
                let updated;
                if (type === 'Email' && folder.type === 3) {
                    try {
                        updated = await require('./drafts').eas(
                            eas,
                            auth,
                            item,
                            data,
                            folderId,
                            id,
                            child(command, 'Email2:Send')
                        );
                    } catch {
                        responses.push(response(kind, kind === 'Add' ? clientId : id, 6, kind === 'Add'));
                        continue;
                    }
                    const box = read('mailboxes', auth.mailbox.id);
                    const usedBytes = box.usedBytes - (item?.size || 0) + updated.size;
                    if (usedBytes > box.quotaBytes) {
                        responses.push(response(kind, kind === 'Add' ? clientId : id, 6, kind === 'Add'));
                        continue;
                    }
                    write('mailboxes', box.id, { ...box, usedBytes });
                    if (updated.send) {
                        const submission = await eas.mail.envelope(
                            await eas.store.getBlob(updated.blob),
                            auth.mailbox
                        );
                        write('outbox', id, {
                            mailbox: auth.mailbox.id,
                            sender: submission.sender,
                            recipients: submission.recipients,
                            blob: updated.blob,
                            size: updated.size,
                            saveInSent: true,
                            status: 'pending',
                            attempts: 0,
                            nextAttempt: 0,
                            draftId: id,
                            reservedBytes: 0
                        });
                        updated.send = false;
                        updated.queued = true;
                    }
                } else if (type === 'Email') {
                    const supported = new Set(['Email:Read', 'Email:Flag', 'Email:Categories']);
                    if (
                        !data.length ||
                        data.some((c) => !supported.has(c.name)) ||
                        new Set(data.map((c) => c.name)).size !== data.length
                    ) {
                        responses.push(response(kind, id, 6));
                        continue;
                    }
                    updated = { ...item };
                    let invalid = false;
                    for (const element of data) {
                        if (element.name === 'Email:Read') {
                            const readValue = element.children.join('');
                            if (!['0', '1'].includes(readValue)) {
                                invalid = true;
                                break;
                            }
                            updated.read = readValue === '1';
                        } else if (element.name === 'Email:Flag') updated.flag = element;
                        else updated.categories = element;
                    }
                    if (invalid) {
                        responses.push(response(kind, id, 6));
                        continue;
                    }
                } else {
                    if (
                        data.some(
                            (c) =>
                                ![
                                    type,
                                    'AirSyncBase',
                                    ...(type === 'Contacts' ? ['Contacts2'] : [])
                                ].includes(c.name.split(':')[0])
                        )
                    ) {
                        responses.push(response(kind, kind === 'Add' ? clientId : id, 6, kind === 'Add'));
                        continue;
                    }
                    const supplied = new Set(data.map((c) => c.name));
                    const calendarGhostable = new Set(
                        [
                            'AllDayEvent',
                            'Reminder',
                            'Exceptions',
                            'Attendees',
                            'OrganizerName',
                            'OrganizerEmail',
                            'MeetingStatus',
                            'ResponseRequested',
                            'DisallowNewTimeProposal'
                        ].map((name) => 'Calendar:' + name)
                    );
                    const preserved =
                        kind === 'Change' && supported !== null
                            ? (item.applicationData || []).filter(
                                  (c) =>
                                      !supplied.has(c.name) &&
                                      !supported.includes(c.name) &&
                                      (type === 'Contacts'
                                          ? /^(Contacts|Contacts2):/.test(c.name)
                                          : calendarGhostable.has(c.name))
                              )
                            : [];
                    try {
                        const merged = [...preserved, ...data];
                        const normalized = require('./classes').validate(type, merged, {
                            previous: item?.calendar,
                            version: auth.protocolVersion
                        });
                        updated = {
                            ...item,
                            mailbox: auth.mailbox.id,
                            folder: folderId,
                            applicationData: merged.filter((c) => c.name !== 'AirSyncBase:Attachments'),
                            ...normalized,
                            date: new Date().toISOString(),
                            size: 0
                        };
                        if (updated.calendar && auth.protocolVersion !== '14.1') {
                            const files = await require('./pim-attachments').update(
                                eas.store,
                                item?.pimAttachments,
                                child(n('AirSync:ApplicationData', data), 'AirSyncBase:Attachments'),
                                id
                            );
                            updated.pimAttachments = files.files;
                            updated.attachmentReplies = files.replies;
                            updated.size = files.files.reduce((sum, file) => sum + file.size, 0);
                        }
                        if (updated.calendar) {
                            updated.date = updated.calendar.start;
                            updated.subject = updated.calendar.subject;
                        }
                    } catch {
                        responses.push(response(kind, kind === 'Add' ? clientId : id, 6, kind === 'Add'));
                        continue;
                    }
                }
                if (type === 'Calendar') {
                    try {
                        const queued = await require('./calendar-sync')(eas, auth, item, updated);
                        for (const entry of queued) write('outbox', entry.id, entry);
                    } catch {
                        responses.push(response(kind, kind === 'Add' ? clientId : id, 6, kind === 'Add'));
                        continue;
                    }
                }
                if (type !== 'Email' && (updated.size || item?.size)) {
                    const box = read('mailboxes', auth.mailbox.id);
                    write('mailboxes', box.id, {
                        ...box,
                        usedBytes: box.usedBytes - (item?.size || 0) + (updated.size || 0)
                    });
                }
                write('messages', id, updated);
                snapshot[id] = revision;
                const attachmentResponse = updated.attachmentReplies?.length
                    ? n('AirSync:ApplicationData', n('AirSyncBase:Attachments', updated.attachmentReplies))
                    : null;
                responses.push(
                    kind === 'Add'
                        ? n(
                              'AirSync:Add',
                              f('ClientId', clientId),
                              f('ServerId', id),
                              f('Status', 1),
                              attachmentResponse
                          )
                        : n('AirSync:Change', f('ServerId', id), f('Status', 1), attachmentResponse)
                );
            }
            const candidates = getChanges ? delta(view, folder, snapshot, options) : [];
            const updates = [];
            let sent = 0;
            for (const candidate of candidates.slice(0, window)) {
                let update;
                if (candidate.item) {
                    const item = candidate.item;
                    update = n(
                        'AirSync:' + (snapshot[item.id] ? 'Change' : 'Add'),
                        f('ServerId', item.id),
                        await eas.applicationData(
                            item,
                            options,
                            candidate.metadataOnly ? 0 : 128 * 1024,
                            auth.protocolVersion
                        )
                    );
                } else
                    update = n(
                        'AirSync:' + (candidate.soft ? 'SoftDelete' : 'Delete'),
                        f('ServerId', candidate.id)
                    );
                const size = encode(n('AirSync:Sync', update)).length;
                if (responseBytes + size > MAX_RESPONSE / 2) break;
                responseBytes += size;
                sent++;
                updates.push(update);
                if (candidate.item) snapshot[candidate.item.id] = candidate.item.revision;
                else delete snapshot[candidate.id];
            }
            const token = crypto.randomUUID();
            write('sync', token, { device: auth.device.id, folder: folderId, snapshot, options, supported });
            results.push(
                n(
                    'AirSync:Collection',
                    f('SyncKey', token),
                    f('CollectionId', folderId),
                    f('Status', 1),
                    responses.length ? n('AirSync:Responses', responses) : null,
                    candidates.length > sent ? n('AirSync:MoreAvailable') : null,
                    updates.length ? n('AirSync:Commands', updates) : null
                )
            );
        }
        const box = read('mailboxes', auth.mailbox.id);
        if (
            box.usedBytes +
                view
                    .list('outbox', (e) => e.status === 'pending')
                    .reduce((sum, e) => sum + (e.reservedBytes ?? e.size), 0) >
            box.quotaBytes
        )
            throw new Error('Mailbox quota exceeded');
        const result = encode(n('AirSync:Sync', n('AirSync:Collections', results)));
        if (result.length > MAX_RESPONSE) throw new Error('Sync response too large');
        write('syncReplies', replayId, { device: auth.device.id, response: result.toString('base64') });
        return changes;
    });
    return decode(Buffer.from(scope.get('syncReplies', replayId).response, 'base64'));
};
