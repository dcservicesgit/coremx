'use strict';
const crypto = require('node:crypto');
const { node: n, child, children, value, encode } = require('./wbxml');
const { delta } = require('./sync-options');
const fail = (status) => n('AirSync:Sync', n('AirSync:Status', String(status)));
module.exports = async (eas, root, auth, signal) => {
    const scope = eas.store.forMailbox(auth.mailbox.id),
        saved = scope.get('clientState', auth.device.id);
    if (!root) {
        if (!saved?.sync) return fail(13);
        root = structuredClone(saved.sync);
    }
    if (child(root, 'AirSync:Partial')) {
        if (!saved?.sync) return fail(13);
        const supplied = children(child(root, 'AirSync:Collections'), 'AirSync:Collection');
        const merged = new Map(
            children(child(saved.sync, 'AirSync:Collections'), 'AirSync:Collection').map((c) => [
                value(c, 'AirSync:CollectionId'),
                c
            ])
        );
        for (const c of supplied) merged.set(value(c, 'AirSync:CollectionId'), c);
        root = n(
            'AirSync:Sync',
            root.children.filter((c) => !['AirSync:Partial', 'AirSync:Collections'].includes(c.name)),
            n('AirSync:Collections', [...merged.values()])
        );
    }
    const collections = children(child(root, 'AirSync:Collections'), 'AirSync:Collection');
    const wait = child(root, 'AirSync:Wait'),
        heartbeat = child(root, 'AirSync:HeartbeatInterval');
    if (wait && heartbeat) return fail(4);
    const seconds = heartbeat ? Number(value(heartbeat)) : wait ? Number(value(wait)) * 60 : 0;
    if ((wait || heartbeat) && (!Number.isInteger(seconds) || seconds < 60 || seconds > 900))
        return n('AirSync:Sync', n('AirSync:Status', '14'), n('AirSync:Limit', '900'));
    if (
        seconds &&
        collections.some((c) => child(c, 'AirSync:Commands') || value(c, 'AirSync:SyncKey') === '0')
    )
        return fail(4);
    const dirty = () =>
        collections.some((c) => {
            const id = value(c, 'AirSync:CollectionId'),
                folder = scope.get('folders', id),
                state = scope.get('sync', value(c, 'AirSync:SyncKey'));
            return (
                !folder ||
                !state ||
                state.device !== auth.device.id ||
                delta(scope, folder, state.snapshot, state.options).length
            );
        });
    if (seconds && !dirty()) {
        eas.syncWaits ||= new Map();
        eas.syncWaits.get(auth.device.id)?.();
        await new Promise((resolve) => {
            let timer;
            const finish = () => {
                clearTimeout(timer);
                eas.store.off('change', change);
                eas.store.off('unavailable', finish);
                signal?.removeEventListener('abort', finish);
                if (eas.syncWaits.get(auth.device.id) === finish) eas.syncWaits.delete(auth.device.id);
                resolve();
            };
            const change = () => {
                const d = eas.store.get('devices', auth.device.id);
                if (
                    d?.revoked ||
                    d?.wipe ||
                    (auth.enforcePolicy &&
                        eas.mail.policy.check(auth, auth.policyKey, auth.protocolVersion)) ||
                    dirty()
                )
                    finish();
            };
            eas.store.on('change', change);
            eas.store.on('unavailable', finish);
            signal?.addEventListener('abort', finish, { once: true });
            eas.syncWaits.set(auth.device.id, finish);
            timer = setTimeout(finish, seconds * 1000);
            if (signal?.aborted || dirty()) finish();
        });
        if (signal?.aborted) throw new Error('Sync cancelled');
        if (eas.store.get('devices', auth.device.id)?.wipe) return fail(140);
    }
    const effective = n(
        'AirSync:Sync',
        root.children.filter((c) => !['AirSync:Wait', 'AirSync:HeartbeatInterval'].includes(c.name))
    );
    const result = await require('./sync')(
        eas,
        effective,
        auth,
        Buffer.concat([Buffer.from(auth.protocolVersion), encode(effective)])
    );
    const responseCollections = children(child(result, 'AirSync:Collections'), 'AirSync:Collection');
    if (responseCollections.length && responseCollections.every((c) => value(c, 'AirSync:Status') === '1')) {
        const keys = new Map(
            responseCollections.map((c) => [value(c, 'AirSync:CollectionId'), value(c, 'AirSync:SyncKey')])
        );
        const cached = n(
            'AirSync:Sync',
            root.children.filter((c) => c.name !== 'AirSync:Collections'),
            n(
                'AirSync:Collections',
                collections.map((c) =>
                    n(
                        'AirSync:Collection',
                        c.children.filter(
                            (f) =>
                                !['AirSync:SyncKey', 'AirSync:Commands', 'AirSync:Supported'].includes(f.name)
                        ),
                        n('AirSync:SyncKey', keys.get(value(c, 'AirSync:CollectionId')))
                    )
                )
            )
        );
        await scope.transaction('sync-request:' + crypto.randomUUID(), () => [
            { collection: 'clientState', id: auth.device.id, value: { ...saved, sync: cached } }
        ]);
    }
    return result;
};
