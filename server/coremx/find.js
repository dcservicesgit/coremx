'use strict';
const { node: n, child, value } = require('./wbxml');
const f = (name, text) => n(name, String(text));
module.exports = async (eas, root, auth) => {
    const execute = child(root, 'Find:ExecuteSearch');
    const mailbox = child(execute, 'Find:MailBoxSearchCriterion');
    const gal = child(execute, 'Find:GalSearchCriterion');
    const wrap = (status, content = []) =>
        n(
            'Find:Find',
            f('Find:Status', 1),
            n(
                'Find:Response',
                f('ItemOperations:Store', mailbox ? 'Mailbox' : 'GAL'),
                f('Find:Status', status),
                content
            )
        );
    if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            value(root, 'Find:SearchId')
        ) ||
        !!mailbox === !!gal
    )
        return wrap(2);
    const criterion = mailbox || gal,
        query = child(criterion, 'Find:Query'),
        options = child(criterion, 'Find:Options');
    const match = /^(\d+)-(\d+)$/.exec(value(options, 'Find:Range', '0-49'));
    if (!match || +match[1] > 100000 || +match[2] < +match[1] || +match[2] - +match[1] >= 100)
        return wrap(12);
    const start = +match[1],
        limit = +match[2] - start + 1;
    let total, results;
    if (gal) {
        const text = value(query).toLowerCase();
        if (!text) return wrap(2);
        const entries = (await eas.mail.search.directory()).filter((e) =>
            [e.name, e.email, e.company].some((v) => v.toLowerCase().includes(text))
        );
        total = entries.length;
        results = entries
            .slice(start, start + limit)
            .map((e) =>
                n(
                    'Find:Result',
                    n('Find:Properties', f('GAL:DisplayName', e.name), f('GAL:EmailAddress', e.email))
                )
            );
    } else {
        if (value(query, 'AirSync:Class', 'Email') !== 'Email') return wrap(2);
        const text = value(query, 'Find:FreeText').replace(/(\w+):\s+/g, '$1:');
        const folder = value(query, 'AirSync:CollectionId') || undefined;
        const scope = eas.store.forMailbox(auth.mailbox.id),
            deep = !!child(options, 'Find:DeepTraversal');
        const queryId = require('node:crypto')
            .createHash('sha256')
            .update(auth.device.id + ':find:' + value(root, 'Find:SearchId'))
            .digest('hex');
        const signature = JSON.stringify({ text, folder, deep });
        let saved = scope.get('searches', queryId);
        if (saved && saved.signature !== signature) return wrap(2);
        if (!saved || start === 0 || Date.now() - saved.createdAt > 600000) {
            let predicate;
            if (folder && deep) {
                if (!scope.get('folders', folder)) return wrap(2);
                predicate = (item) => {
                    let current = item.folder;
                    const seen = new Set();
                    while (current && !seen.has(current)) {
                        if (current === folder) return true;
                        seen.add(current);
                        current = scope.get('folders', current)?.parent;
                    }
                    return false;
                };
            }
            let found;
            try {
                found = await eas.mail.search.mailbox(auth, {
                    query: text,
                    folder: deep ? undefined : folder,
                    predicate,
                    limit: 1,
                    signal: auth.signal
                });
            } catch {
                return wrap(8);
            }
            if (found.ids.length > 10000) return wrap(8);
            saved = {
                signature,
                ids: found.ids,
                total: found.total,
                createdAt: Date.now(),
                device: auth.device.id
            };
            await scope.transaction('find:' + require('node:crypto').randomUUID(), () => [
                { collection: 'searches', id: queryId, value: saved }
            ]);
        }
        total = saved.total;
        results = saved.ids
            .slice(start, start + limit)
            .map((id) => scope.get('messages', id))
            .filter(Boolean)
            .map((m) =>
                n(
                    'Find:Result',
                    f('AirSync:Class', 'Email'),
                    f('AirSync:ServerId', m.id),
                    f('AirSync:CollectionId', m.folder),
                    n(
                        'Find:Properties',
                        f('Email:Subject', m.subject || ''),
                        f('Email:From', m.from || ''),
                        f('Email:DateReceived', m.date),
                        f('Email:Read', m.read ? 1 : 0),
                        f('Find:Preview', m.preview || ''),
                        f('Find:HasAttachments', m.hasAttachments ? 1 : 0)
                    )
                )
            );
    }
    return wrap(1, [
        ...results,
        results.length ? f('Find:Range', `${start}-${start + results.length - 1}`) : null,
        f('Find:Total', total)
    ]);
};
