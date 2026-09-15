'use strict';
const crypto = require('node:crypto');
const { itemClass, syncOptions, bodyData, delta } = require('./sync-options');
const { node: n, child, children, value, encode, decode } = require('./wbxml');
const uid = () => crypto.randomUUID();
const commands = [
    'FolderSync',
    'FolderCreate',
    'FolderUpdate',
    'FolderDelete',
    'Sync',
    'Ping',
    'SendMail',
    'GetItemEstimate',
    'MoveItems',
    'ItemOperations',
    'Settings',
    'Provision',
    'SmartReply',
    'SmartForward',
    'MeetingResponse',
    'Search',
    'ResolveRecipients',
    'Find'
];
const field = (ns, key, val) => n(ns + ':' + key, String(val));
class ActiveSync {
    constructor(mail) {
        this.mail = mail;
        this.store = mail.store;
        this.pings = new Map();
    }
    async execute(command, bytes, auth, signal, transport = {}) {
        const protocol = require('./protocol');
        const version = transport.version || auth.protocolVersion || '14.1';
        auth = {
            ...auth,
            protocolVersion: version,
            signal,
            enforcePolicy: !!transport.enforcePolicy,
            policyKey: transport.policyKey
        };
        const output = (result) => ({
            status: 200,
            headers: [
                ['content-type', 'application/vnd.ms-sync.wbxml'],
                ['cache-control', 'no-store']
            ],
            body: result ? encode(result) : Buffer.alloc(0)
        });
        if (!commands.includes(command))
            return command === 'ValidateCert'
                ? output(protocol.error(command, 137))
                : { status: 501, body: '' };
        if (!protocol.versions.includes(version) || (command === 'Find' && version !== '16.1'))
            return output(protocol.error(command, 138));
        if (this.store.failed) return { status: 503, body: '' };
        try {
            let root;
            try {
                root = bytes.length ? decode(bytes) : null;
            } catch {
                throw Object.assign(new Error('Malformed WBXML'), { easStatus: 102 });
            }
            if (root && root.name !== protocol.rootName(command))
                throw Object.assign(new Error('Command/body mismatch'), { easStatus: 103 });
            if (!root && !['Ping', 'Sync'].includes(command))
                throw Object.assign(new Error('Missing WBXML body'), { easStatus: 102 });
            if (root) {
                protocol.validateVersion(root, version);
                protocol.validateRoot(command, root);
            }
            if (transport.enforcePolicy && command !== 'Provision') {
                const status = this.mail.policy.check(auth, transport.policyKey, version);
                if (status) return output(protocol.error(command, status));
            }
            const result = await this[command](root, auth, signal, bytes);
            if (auth.enforcePolicy && command !== 'Provision') {
                const status = this.mail.policy.check(auth, auth.policyKey, version);
                if (status) return output(protocol.error(command, status));
            }
            if (command === 'ItemOperations' && transport.multipart)
                return {
                    status: 200,
                    headers: [
                        ['content-type', 'application/vnd.ms-sync.multipart'],
                        ['cache-control', 'no-store']
                    ],
                    body: require('./item-operations').multipart(result)
                };
            return output(result);
        } catch (error) {
            if (this.store.failed) return { status: 503, body: '' };
            return output(
                protocol.error(
                    command,
                    error.easStatus ||
                        (/quota/i.test(error.message)
                            ? 113
                            : /cancelled|unavailable/i.test(error.message)
                              ? 110
                              : 103)
                )
            );
        }
    }
    folder(auth, id) {
        const folder = this.store.forMailbox(auth.mailbox.id).get('folders', id);
        if (!folder || folder.mailbox !== auth.mailbox.id) throw new Error('Folder unavailable');
        return folder;
    }
    async FolderSync(root, auth) {
        const scope = this.store.forMailbox(auth.mailbox.id);
        const key = value(root, 'FolderHierarchy:SyncKey');
        const old = key === '0' ? null : scope.get('hierarchy', key);
        if (key !== '0' && (!old || old.device !== auth.device.id))
            return n('FolderHierarchy:FolderSync', field('FolderHierarchy', 'Status', 9));
        const folders = scope.list(
            'folders',
            (f) => f.mailbox === auth.mailbox.id && (f.type !== 3 || auth.protocolVersion !== '14.1')
        );
        const snapshot = Object.fromEntries(folders.map((f) => [f.id, f.revision]));
        const token = uid();
        const changes = [];
        for (const f of folders)
            if (old?.snapshot[f.id] !== f.revision)
                changes.push(
                    n(
                        'FolderHierarchy:' + (old?.snapshot[f.id] ? 'Update' : 'Add'),
                        field('FolderHierarchy', 'ServerId', f.id),
                        field('FolderHierarchy', 'ParentId', f.parent),
                        field('FolderHierarchy', 'DisplayName', f.name),
                        field('FolderHierarchy', 'Type', f.type)
                    )
                );
        for (const id of Object.keys(old?.snapshot || {}))
            if (!snapshot[id])
                changes.push(n('FolderHierarchy:Delete', field('FolderHierarchy', 'ServerId', id)));
        await scope.transaction('hierarchy:' + token, () => [
            { collection: 'hierarchy', id: token, value: { device: auth.device.id, snapshot } }
        ]);
        return n(
            'FolderHierarchy:FolderSync',
            field('FolderHierarchy', 'Status', 1),
            field('FolderHierarchy', 'SyncKey', token),
            n('FolderHierarchy:Changes', field('FolderHierarchy', 'Count', changes.length), changes)
        );
    }
    async changeFolder(root, auth, command) {
        const scope = this.store.forMailbox(auth.mailbox.id);
        const replayId = crypto
            .createHash('sha256')
            .update(command + auth.device.id)
            .update(encode(root))
            .digest('hex');
        await scope.transaction('folder-result:' + replayId, (store) => {
            const old = store.get('hierarchy', value(root, 'FolderHierarchy:SyncKey'));
            const id = command === 'FolderCreate' ? uid() : value(root, 'FolderHierarchy:ServerId');
            const current = command === 'FolderCreate' ? null : store.get('folders', id);
            const name = value(root, 'FolderHierarchy:DisplayName');
            const parent = value(root, 'FolderHierarchy:ParentId', '0');
            const type = current?.type || Number(value(root, 'FolderHierarchy:Type', '12'));
            let status = 1;
            if (!old || old.device !== auth.device.id) status = 9;
            else if (command !== 'FolderCreate' && !current) status = 4;
            else if (current && current.type < 12) status = 3;
            else if (command !== 'FolderDelete') {
                if (!name || name.length > 255 || ![12, 13, 14, 15, 17].includes(type)) status = 10;
                else if (parent !== '0' && !store.get('folders', parent)) status = 5;
                else if (
                    store.list(
                        'folders',
                        (f) =>
                            f.parent === parent && f.name.toLowerCase() === name.toLowerCase() && f.id !== id
                    ).length
                )
                    status = 2;
                const visited = new Set([id]);
                let ancestor = parent;
                while (ancestor !== '0' && status === 1) {
                    if (visited.has(ancestor)) {
                        status = 5;
                        break;
                    }
                    visited.add(ancestor);
                    ancestor = store.get('folders', ancestor)?.parent || '0';
                }
            } else if (
                store.list('messages', (m) => m.folder === id).length ||
                store.list('folders', (f) => f.parent === id).length
            )
                status = 6;
            const changes = [];
            let token;
            if (status === 1) {
                changes.push({
                    collection: 'folders',
                    id,
                    value:
                        command === 'FolderDelete' ? null : { mailbox: auth.mailbox.id, name, parent, type }
                });
                token = uid();
                const snapshot = { ...old.snapshot };
                if (command === 'FolderDelete') delete snapshot[id];
                else snapshot[id] = this.store.sequence + 1;
                changes.push({
                    collection: 'hierarchy',
                    id: token,
                    value: { device: auth.device.id, snapshot }
                });
            }
            const result = n(
                'FolderHierarchy:' + command,
                field('FolderHierarchy', 'Status', status),
                token ? field('FolderHierarchy', 'SyncKey', token) : null,
                status === 1 && command === 'FolderCreate' ? field('FolderHierarchy', 'ServerId', id) : null
            );
            changes.push({
                collection: 'syncReplies',
                id: replayId,
                value: { device: auth.device.id, response: encode(result).toString('base64') }
            });
            return changes;
        });
        return decode(Buffer.from(scope.get('syncReplies', replayId).response, 'base64'));
    }
    FolderCreate(r, a) {
        return this.changeFolder(r, a, 'FolderCreate');
    }
    FolderUpdate(r, a) {
        return this.changeFolder(r, a, 'FolderUpdate');
    }
    FolderDelete(r, a) {
        return this.changeFolder(r, a, 'FolderDelete');
    }
    async pimData(elements, options = {}, maxBytes = 128 * 1024) {
        let remaining = maxBytes;
        const walk = async (element) => {
            if (!element || typeof element !== 'object' || Buffer.isBuffer(element)) return element;
            if (element.name === 'AirSyncBase:Body') {
                const type = value(element, 'AirSyncBase:Type', '1');
                const source = value(element, 'AirSyncBase:Data');
                const parsed =
                    type === '2'
                        ? await this.mail.parse(
                              Buffer.from('Content-Type: text/html; charset=utf-8\r\n\r\n' + source)
                          )
                        : { text: source, headers: new Map() };
                const body = bodyData(parsed, Buffer.alloc(0), { ...options, mime: 0 }, remaining)[0];
                remaining = Math.max(0, remaining - Buffer.byteLength(value(body, 'AirSyncBase:Data')));
                return body;
            }
            const result = [];
            for (const entry of element.children || []) result.push(await walk(entry));
            return n(element.name, result);
        };
        const result = [];
        for (const element of elements) result.push(await walk(element));
        return result;
    }
    async applicationData(message, options, maxBytes, version = '14.1') {
        if (message.calendar)
            return n(
                'AirSync:ApplicationData',
                await this.pimData(
                    require('./calendar-codec').toEas(message.calendar, version),
                    options,
                    maxBytes
                ),
                version !== '14.1' && options?.attachmentsEnabled !== false && message.pimAttachments?.length
                    ? require('./pim-attachments').data(
                          message.pimAttachments.filter(
                              (f) => f.size <= (options?.maxAttachmentSize ?? Infinity)
                          ),
                          message.id
                      )
                    : null
            );
        if (message.applicationData)
            return n(
                'AirSync:ApplicationData',
                await this.pimData(message.applicationData, options, maxBytes)
            );
        const raw = await this.store.getBlob(message.blob);
        const parsed = await this.mail.parse(raw);
        return n(
            'AirSync:ApplicationData',
            field('Email', 'To', parsed.to?.text || ''),
            field('Email', 'From', parsed.from?.text || ''),
            field('Email', 'Cc', parsed.cc?.text || ''),
            field('Email', 'ReplyTo', parsed.replyTo?.text || ''),
            field('Email', 'Subject', parsed.subject || ''),
            field('Email', 'DateReceived', message.date),
            field('Email', 'Read', message.read ? 1 : 0),
            field('Email', 'Importance', 1),
            field(
                'Email',
                'MessageClass',
                message.meeting
                    ? 'IPM.Schedule.Meeting.' +
                          (message.meeting.method === 'CANCEL'
                              ? 'Canceled'
                              : message.meeting.method === 'REPLY'
                                ? 'Resp.Pos'
                                : 'Request')
                    : 'IPM.Note'
            ),
            version !== '14.1' ? field('Email2', 'IsDraft', message.draft ? 1 : 0) : null,
            version !== '14.1' && message.draft ? field('Email2', 'Bcc', parsed.bcc?.text || '') : null,
            message.lastVerb ? field('Email2', 'LastVerbExecuted', message.lastVerb) : null,
            message.lastVerbAt ? field('Email2', 'LastVerbExecutionTime', message.lastVerbAt) : null,
            message.conversation
                ? n('Email2:ConversationId', Buffer.from(message.conversation, 'hex').subarray(0, 16))
                : null,
            n(
                'Email2:ConversationIndex',
                message.conversationIndex
                    ? Buffer.from(message.conversationIndex, 'base64')
                    : require('./conversation').header(message.date)
            ),
            message.meeting ? require('./meeting-response').metadata(message.meeting, version) : null,
            message.flag || n('Email:Flag'),
            message.categories || n('Email:Categories'),
            options?.part
                ? await require('./body-part')(this, message, parsed, options, maxBytes)
                : bodyData(parsed, raw, options, maxBytes),
            parsed.attachments.length && options?.attachmentsEnabled !== false
                ? n(
                      'AirSyncBase:Attachments',
                      parsed.attachments.map((a, i) =>
                          a.size > (options?.maxAttachmentSize ?? Infinity)
                              ? null
                              : n(
                                    'AirSyncBase:Attachment',
                                    field('AirSyncBase', 'DisplayName', a.filename || 'attachment'),
                                    field(
                                        'AirSyncBase',
                                        'FileReference',
                                        message.attachmentIds?.[i]
                                            ? message.id + ':d:' + message.attachmentIds[i]
                                            : message.id + ':' + i
                                    ),
                                    field('AirSyncBase', 'Method', 1),
                                    field('AirSyncBase', 'EstimatedDataSize', a.size),
                                    a.cid ? field('AirSyncBase', 'ContentId', a.cid) : null,
                                    field(
                                        'AirSyncBase',
                                        'IsInline',
                                        a.contentDisposition === 'inline' ? 1 : 0
                                    )
                                )
                      )
                  )
                : null
        );
    }
    Sync(root, auth, signal, bytes) {
        return require('./sync-request')(this, root, auth, signal, bytes);
    }
    async Ping(root, auth, signal) {
        const scope = this.store.forMailbox(auth.mailbox.id);
        const previous = scope.get('ping', auth.device.id);
        const heartbeat = Number(value(root, 'Ping:HeartbeatInterval', String(previous?.heartbeat || 480)));
        if (!Number.isInteger(heartbeat) || heartbeat < 60 || heartbeat > 900)
            return n(
                'Ping:Ping',
                field('Ping', 'Status', 5),
                field('Ping', 'HeartbeatInterval', heartbeat < 60 ? 60 : 900)
            );
        let folders = children(child(root, 'Ping:Folders'), 'Ping:Folder').map((f) => value(f, 'Ping:Id'));
        if (!folders.length) folders = previous?.folders || [];
        if (!folders.length) return n('Ping:Ping', field('Ping', 'Status', 3));
        if (folders.length > 20)
            return n('Ping:Ping', field('Ping', 'Status', 6), field('Ping', 'MaxFolders', 20));
        if (new Set(folders).size !== folders.length) return n('Ping:Ping', field('Ping', 'Status', 4));
        if (folders.some((id) => !scope.get('folders', id)))
            return n('Ping:Ping', field('Ping', 'Status', 7));
        const dirtyFolders = () =>
            folders.filter((id) => {
                const folder = scope.get('folders', id);
                if (!folder) return true;
                const latest = scope
                    .list('sync', (state) => state.device === auth.device.id && state.folder === id)
                    .sort((a, b) => b.revision - a.revision)[0];
                return delta(scope, folder, latest?.snapshot || {}, latest?.options).length > 0;
            });
        const start = this.store.sequence;
        await scope.transaction('ping:' + uid(), () => [
            { collection: 'ping', id: auth.device.id, value: { folders, heartbeat } }
        ]);
        this.pings.get(auth.device.id)?.();
        const changed = await new Promise((resolve) => {
            let timer;
            const finish = (result) => {
                clearTimeout(timer);
                this.store.off('change', change);
                this.store.off('unavailable', unavailable);
                signal?.removeEventListener('abort', unavailable);
                if (this.pings.get(auth.device.id) === unavailable) this.pings.delete(auth.device.id);
                resolve(result);
            };
            const unavailable = () => finish(null);
            const change = (record) => {
                if (
                    auth.enforcePolicy &&
                    this.mail.policy.check(auth, auth.policyKey, auth.protocolVersion)
                ) {
                    finish(null);
                    return;
                }
                if (
                    this.store.get('devices', auth.device.id)?.revoked ||
                    this.store.get('devices', auth.device.id)?.wipe
                ) {
                    finish(null);
                    return;
                }
                if (
                    record.sequence > start &&
                    record.changes.some(
                        (c) => c.collection === scope.collection && /^(messages|folders)_/.test(c.id)
                    )
                ) {
                    const changed = dirtyFolders();
                    if (changed.length) finish(changed);
                }
                if (!this.store.get('mailboxes', auth.mailbox.id)?.enabled) finish(null);
            };
            this.store.on('change', change);
            this.store.on('unavailable', unavailable);
            signal?.addEventListener('abort', unavailable, { once: true });
            this.pings.set(auth.device.id, unavailable);
            timer = setTimeout(() => finish(dirtyFolders()), heartbeat * 1000);
            const dirty = dirtyFolders();
            if (
                signal?.aborted ||
                this.store.get('devices', auth.device.id)?.revoked ||
                !this.store.get('mailboxes', auth.mailbox.id)?.enabled
            )
                unavailable();
            else if (dirty.length) finish(dirty);
        });
        if (changed === null) {
            const policyStatus =
                auth.enforcePolicy && this.mail.policy.check(auth, auth.policyKey, auth.protocolVersion);
            if (policyStatus) return n('Ping:Ping', field('Ping', 'Status', policyStatus));
            if (this.store.get('devices', auth.device.id)?.wipe)
                return n('Ping:Ping', field('Ping', 'Status', 140));
            throw new Error('Device request cancelled');
        }
        if (changed.some((id) => !scope.get('folders', id)))
            return n('Ping:Ping', field('Ping', 'Status', 7));
        return n(
            'Ping:Ping',
            field('Ping', 'Status', changed.length ? 2 : 1),
            changed.length
                ? n(
                      'Ping:Folders',
                      changed.map((id) => field('Ping', 'Folder', id))
                  )
                : null
        );
    }
    async SendMail(root, auth) {
        const mime = child(root, 'ComposeMail:Mime')?.children?.[0];
        if (!Buffer.isBuffer(mime) && typeof mime !== 'string') throw new Error('Missing MIME');
        await this.mail.submit(
            auth,
            Buffer.from(mime),
            value(root, 'ComposeMail:ClientId'),
            !!child(root, 'ComposeMail:SaveInSentItems')
        );
        return null;
    }
    async GetItemEstimate(root, auth) {
        const scope = this.store.forMailbox(auth.mailbox.id);
        const collections = children(
            child(root, 'GetItemEstimate:Collections'),
            'GetItemEstimate:Collection'
        );
        if (!collections.length || collections.length > 30)
            return n('GetItemEstimate:GetItemEstimate', field('GetItemEstimate', 'Status', 103));
        return n(
            'GetItemEstimate:GetItemEstimate',
            collections.map((c) => {
                const id = value(c, 'GetItemEstimate:CollectionId');
                const folder = scope.get('folders', id);
                const key = value(c, 'AirSync:SyncKey');
                const state = scope.get('sync', key);
                let status = !folder
                    ? 2
                    : key === '0'
                      ? 3
                      : !state || state.device !== auth.device.id || state.folder !== id
                        ? 4
                        : 1;
                let count;
                if (status === 1) {
                    try {
                        count = delta(
                            scope,
                            folder,
                            state.snapshot,
                            this.mail.policy.filterOptions(
                                auth,
                                syncOptions(c, folder, state.options),
                                itemClass(folder)
                            )
                        ).length;
                    } catch {
                        status = 2;
                    }
                }
                return n(
                    'GetItemEstimate:Response',
                    field('GetItemEstimate', 'Status', status),
                    n(
                        'GetItemEstimate:Collection',
                        field('GetItemEstimate', 'CollectionId', id),
                        status === 1 ? field('GetItemEstimate', 'Estimate', count) : null
                    )
                );
            })
        );
    }
    async MoveItems(root, auth) {
        const scope = this.store.forMailbox(auth.mailbox.id);
        const results = [];
        const moves = children(root, 'Move:Move');
        if (!moves.length || moves.length > 100) return n('Move:MoveItems', field('Move', 'Status', 103));
        for (const move of moves) {
            const id = value(move, 'Move:SrcMsgId');
            const from = value(move, 'Move:SrcFldId');
            const to = value(move, 'Move:DstFldId');
            let status = 3;
            await scope.transaction('move:' + uid(), (store) => {
                const source = store.get('folders', from);
                const destination = store.get('folders', to);
                const item = store.get('messages', id);
                if (!source || !item) status = 1;
                else if (item.queued) status = 5;
                else if (!destination || itemClass(source) !== itemClass(destination)) status = 2;
                else if (from === to) status = 4;
                else if (
                    item.folder === to &&
                    item.lastMove?.device === auth.device.id &&
                    item.lastMove.from === from
                )
                    return [];
                else if (item.folder !== from) status = 1;
                else
                    return [
                        {
                            collection: 'messages',
                            id,
                            value: { ...item, folder: to, lastMove: { device: auth.device.id, from } }
                        }
                    ];
                return [];
            });
            results.push(
                n(
                    'Move:Response',
                    field('Move', 'SrcMsgId', id),
                    field('Move', 'Status', status),
                    status === 3 ? field('Move', 'DstMsgId', id) : null
                )
            );
        }
        return n('Move:MoveItems', results);
    }
    ItemOperations(root, auth) {
        return require('./item-operations')(this, root, auth);
    }
    async Settings(root, auth) {
        const scope = this.store.forMailbox(auth.mailbox.id);
        const response = [field('Settings', 'Status', 1)];
        if (child(root, 'Settings:DeviceInformation')) {
            const info = child(child(root, 'Settings:DeviceInformation'), 'Settings:Set');
            if (!info || Buffer.byteLength(JSON.stringify(info)) > 8192)
                throw new Error('Invalid device information');
            await scope.transaction('device-info:' + uid(), (store) => [
                {
                    collection: 'devices',
                    id: auth.device.id,
                    value: { ...store.get('devices', auth.device.id), information: info.children }
                }
            ]);
            response.push(n('Settings:DeviceInformation', field('Settings', 'Status', 1)));
        }
        if (child(root, 'Settings:UserInformation'))
            response.push(
                n(
                    'Settings:UserInformation',
                    field('Settings', 'Status', 1),
                    n(
                        'Settings:Get',
                        n('Settings:EmailAddresses', field('Settings', 'SMTPAddress', auth.mailbox.email))
                    )
                )
            );
        for (const key of ['Oof', 'DevicePassword', 'RightsManagementInformation'])
            if (child(root, 'Settings:' + key))
                response.push(n('Settings:' + key, field('Settings', 'Status', 6)));
        return n('Settings:Settings', response);
    }
    Provision(root, auth) {
        return this.mail.policy.provision(root, auth, auth.protocolVersion);
    }
    SmartReply(root, auth) {
        return require('./smart-mail')(this, 'SmartReply', root, auth);
    }
    SmartForward(root, auth) {
        return require('./smart-mail')(this, 'SmartForward', root, auth);
    }
    MeetingResponse(root, auth) {
        return require('./meeting-response')(this, root, auth);
    }
    Search(root, auth) {
        return this.mail.search.eas(this, root, auth);
    }
    ResolveRecipients(root, auth) {
        return this.mail.search.resolve(root, auth);
    }
    Find(root, auth) {
        return require('./find')(this, root, auth);
    }
}
module.exports = { ActiveSync, commands };
