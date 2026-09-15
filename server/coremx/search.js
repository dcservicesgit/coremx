'use strict';
const crypto = require('node:crypto');
const { node: n, child, children, value } = require('./wbxml');
const { bodyOptions } = require('./sync-options');
const f = (ns, key, text) => n(ns + ':' + key, String(text));
const lower = (text) =>
    String(text || '')
        .normalize('NFKC')
        .toLocaleLowerCase('en');
class SearchService {
    constructor(mail) {
        this.mail = mail;
        this.store = mail.store;
    }
    async directory() {
        const users = this.mail.directoryProvider ? await this.mail.directoryProvider() : [];
        const profiles = new Map(users.map((u) => [u.eguid || u.id, u]));
        return this.store
            .list('mailboxes', (m) => m.enabled && !m.hiddenFromAddressBook)
            .map((box) => {
                const user = profiles.get(box.owner) || {};
                return {
                    id: box.id,
                    email: box.email,
                    name: box.displayName || user.name || box.email,
                    firstName: user.firstName || '',
                    lastName: user.lastName || '',
                    phone: user.phone || '',
                    company: user.company || ''
                };
            });
    }
    async recipients(auth, query, limit = 20) {
        const q = lower(query);
        if (!q || q.length > 320) return [];
        const contacts = this.store
            .forMailbox(auth.mailbox.id)
            .list('messages', (m) => m.applicationData?.some((c) => c.name.startsWith('Contacts:')))
            .flatMap((item) => {
                const data = n('AirSync:ApplicationData', item.applicationData);
                const name = [value(data, 'Contacts:FirstName'), value(data, 'Contacts:LastName')]
                    .filter(Boolean)
                    .join(' ');
                return [1, 2, 3]
                    .map((index) => value(data, `Contacts:Email${index}Address`))
                    .filter(Boolean)
                    .map((email) => ({ email, name: name || email, personal: true }));
            });
        const unique = new Map();
        for (const entry of [...contacts, ...(await this.directory())])
            if (lower(entry.email).includes(q) || lower(entry.name).includes(q))
                unique.set(lower(entry.email), entry);
        const results = [...unique.values()].sort(
            (a, b) =>
                Number(lower(b.email) === q) - Number(lower(a.email) === q) || a.name.localeCompare(b.name)
        );
        const exact = results.filter((r) => lower(r.email) === q);
        return (exact.length ? exact : results).slice(0, limit);
    }
    async mailbox(
        auth,
        {
            query = '',
            folder,
            offset = 0,
            limit = 50,
            unread = false,
            starred = false,
            predicate,
            signal
        } = {}
    ) {
        if (
            typeof query !== 'string' ||
            query.length > 2048 ||
            !Number.isInteger(offset) ||
            offset < 0 ||
            offset > 100000 ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 1000
        )
            throw new Error('Invalid search request');
        const scope = this.store.forMailbox(auth.mailbox.id);
        if (folder && !scope.get('folders', folder)) throw new Error('Folder unavailable');
        const test = require('./query')(query);
        const items = scope
            .list(
                'messages',
                (item) =>
                    !!item.blob &&
                    (!folder || item.folder === folder) &&
                    (!unread || !item.read) &&
                    (!starred || item.starred || value(item.flag, 'Email:Status') === '2')
            )
            .sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || a.id.localeCompare(b.id));
        const results = [];
        for (const item of items) {
            if (signal?.aborted) throw new Error('Search cancelled');
            let parsed;
            const text = async () => {
                parsed ||= await this.mail.parse(await this.store.getBlob(item.blob));
                return lower(
                    [parsed.subject, parsed.from?.text, parsed.to?.text, parsed.cc?.text, parsed.text].join(
                        '\n'
                    )
                );
            };
            const matches = await test(
                item,
                async () => {
                    parsed ||= await this.mail.parse(await this.store.getBlob(item.blob));
                    return parsed;
                },
                scope.get('folders', item.folder)
            );
            if (matches && (!predicate || (await predicate(item, text)))) results.push(item);
        }
        return {
            total: results.length,
            items: results.slice(offset, offset + limit),
            ids: results.map((item) => item.id)
        };
    }
    async eas(eas, root, auth) {
        const request = child(root, 'Search:Store');
        const name = value(request, 'Search:Name');
        const options = child(request, 'Search:Options');
        const range = value(options, 'Search:Range', '0-49');
        const match = /^(\d+)-(\d+)$/.exec(range);
        const wrap = (status, content = []) =>
            n(
                'Search:Search',
                f('Search', 'Status', 1),
                n('Search:Response', n('Search:Store', f('Search', 'Status', status), content))
            );
        if (!match || +match[2] < +match[1] || +match[2] - +match[1] >= 100 || +match[1] > 100000)
            return wrap(12);
        const start = +match[1],
            count = +match[2] - start + 1;
        const query = child(request, 'Search:Query');
        let results, total;
        if (name === 'GAL') {
            const text = lower(value(query));
            if (!text || text.length > 320) return wrap(2);
            const all = (await this.directory()).filter((entry) =>
                [entry.email, entry.name, entry.firstName, entry.lastName, entry.company].some((field) =>
                    lower(field).startsWith(text)
                )
            );
            total = all.length;
            results = all
                .slice(start, start + count)
                .map((entry) =>
                    n(
                        'Search:Result',
                        n(
                            'Search:Properties',
                            f('GAL', 'DisplayName', entry.name),
                            f('GAL', 'EmailAddress', entry.email),
                            entry.firstName ? f('GAL', 'FirstName', entry.firstName) : null,
                            entry.lastName ? f('GAL', 'LastName', entry.lastName) : null,
                            entry.phone ? f('GAL', 'Phone', entry.phone) : null,
                            entry.company ? f('GAL', 'Company', entry.company) : null
                        )
                    )
                );
        } else if (name === 'Mailbox') {
            const scope = this.store.forMailbox(auth.mailbox.id);
            const deep = !!child(options, 'Search:DeepTraversal');
            const compile = (node, depth = 0) => {
                if (!node || depth > 12) throw new Error('Search too complex');
                if (['Search:Query', 'Search:And', 'Search:Or'].includes(node.name)) {
                    const operands = node.children.filter((c) => c.name).map((c) => compile(c, depth + 1));
                    if (!operands.length) throw new Error('Empty search');
                    return async (item, text) => {
                        const values = await Promise.all(operands.map((test) => test(item, text)));
                        return node.name === 'Search:Or' ? values.some(Boolean) : values.every(Boolean);
                    };
                }
                if (node.name === 'Search:FreeText') {
                    const q = lower(value(node));
                    if (q.length > 2048) throw new Error('Search too large');
                    return async (_, text) => (await text()).includes(q);
                }
                if (node.name === 'Search:ConversationId') {
                    const raw = node.children[0];
                    const id = Buffer.isBuffer(raw)
                        ? raw.toString('hex')
                        : Buffer.from(value(node), 'base64').toString('hex');
                    if (id.length !== 32) throw new Error('Invalid conversation');
                    return (item) => item.conversation?.startsWith(id);
                }
                if (node.name === 'AirSync:Class') {
                    if (value(node) !== 'Email') throw new Error('Unsupported class');
                    return () => true;
                }
                if (node.name === 'AirSync:CollectionId') {
                    const id = value(node);
                    if (!scope.get('folders', id)) throw new Error('Folder unavailable');
                    return (item) => {
                        let folder = item.folder;
                        const seen = new Set();
                        while (folder && !seen.has(folder)) {
                            if (folder === id) return true;
                            if (!deep) return false;
                            seen.add(folder);
                            folder = scope.get('folders', folder)?.parent;
                        }
                        return false;
                    };
                }
                if (['Search:GreaterThan', 'Search:LessThan', 'Search:EqualTo'].includes(node.name)) {
                    if (!child(node, 'Email:DateReceived')) throw new Error('Unsupported search property');
                    const date = Date.parse(value(node, 'Search:Value'));
                    if (!Number.isFinite(date)) throw new Error('Invalid date');
                    return (item) =>
                        node.name === 'Search:GreaterThan'
                            ? Date.parse(item.date) > date
                            : node.name === 'Search:LessThan'
                              ? Date.parse(item.date) < date
                              : Date.parse(item.date) === date;
                }
                throw new Error('Unsupported search expression');
            };
            let predicate;
            try {
                predicate = compile(query);
            } catch {
                return wrap(8);
            }
            const identity = crypto
                .createHash('sha256')
                .update(auth.device.id + JSON.stringify(query) + deep)
                .digest('hex');
            let saved = scope.get('searches', identity);
            if (
                !saved ||
                !start ||
                child(options, 'Search:RebuildResults') ||
                Date.now() - saved.createdAt > 600000
            ) {
                const found = await this.mailbox(auth, { predicate, limit: 1 });
                if (found.ids.length > 10000) return wrap(8);
                saved = { ids: found.ids, total: found.total, createdAt: Date.now(), device: auth.device.id };
                await scope.transaction('search:' + crypto.randomUUID(), () => [
                    { collection: 'searches', id: identity, value: saved }
                ]);
            }
            total = saved.total;
            results = [];
            for (const id of saved.ids.slice(start, start + count)) {
                const item = scope.get('messages', id);
                if (item)
                    results.push(
                        n(
                            'Search:Result',
                            f('AirSync', 'Class', 'Email'),
                            f('Search', 'LongId', id),
                            f('AirSync', 'CollectionId', item.folder),
                            n(
                                'Search:Properties',
                                (
                                    await eas.applicationData(
                                        item,
                                        this.mail.policy.filterOptions(auth, bodyOptions(options), 'Email'),
                                        16384,
                                        auth.protocolVersion
                                    )
                                ).children
                            )
                        )
                    );
            }
        } else return wrap(3);
        return wrap(1, [
            ...results,
            results.length ? f('Search', 'Range', `${start}-${start + results.length - 1}`) : null,
            f('Search', 'Total', total)
        ]);
    }
    async resolve(root, auth) {
        const options = child(root, 'ResolveRecipients:Options');
        const max = Number(value(options, 'ResolveRecipients:MaxAmbiguousRecipients', '20'));
        if (!Number.isInteger(max) || max < 0 || max > 100)
            return n('ResolveRecipients:ResolveRecipients', f('ResolveRecipients', 'Status', 5));
        const queries = children(root, 'ResolveRecipients:To');
        if (!queries.length || queries.length > 100)
            return n('ResolveRecipients:ResolveRecipients', f('ResolveRecipients', 'Status', 5));
        const responses = [];
        for (const query of queries) {
            const text = value(query);
            const entries = await this.recipients(auth, text, Math.max(2, max + 1));
            const recipients = [];
            for (const entry of entries.length === 1 ? entries : entries.slice(0, max)) {
                const extra = [];
                const availability = child(options, 'ResolveRecipients:Availability');
                if (availability) {
                    const start = Date.parse(value(availability, 'ResolveRecipients:StartTime'));
                    const end = Date.parse(value(availability, 'ResolveRecipients:EndTime'));
                    if (
                        !Number.isFinite(start) ||
                        !Number.isFinite(end) ||
                        end <= start ||
                        end - start > 42 * 86400000
                    )
                        extra.push(n('ResolveRecipients:Availability', f('ResolveRecipients', 'Status', 5)));
                    else if (!entry.id)
                        extra.push(
                            n('ResolveRecipients:Availability', f('ResolveRecipients', 'Status', 163))
                        );
                    else {
                        const box = this.store.get('mailboxes', entry.id);
                        const events = this.mail.calendar.list(
                            { mailbox: box },
                            new Date(start).toISOString(),
                            new Date(end).toISOString()
                        );
                        const slots = Array.from(
                            { length: Math.ceil((end - start) / 1800000) },
                            (_, index) => {
                                const from = start + index * 1800000;
                                return Math.max(
                                    0,
                                    ...events
                                        .filter(
                                            (e) =>
                                                e.busy &&
                                                Date.parse(e.start) < from + 1800000 &&
                                                Date.parse(e.end) > from
                                        )
                                        .map((e) => Math.min(3, e.busy))
                                );
                            }
                        ).join('');
                        extra.push(
                            n(
                                'ResolveRecipients:Availability',
                                f('ResolveRecipients', 'Status', 1),
                                f('ResolveRecipients', 'MergedFreeBusy', slots)
                            )
                        );
                    }
                }
                if (child(options, 'ResolveRecipients:CertificateRetrieval'))
                    extra.push(
                        n(
                            'ResolveRecipients:Certificates',
                            f('ResolveRecipients', 'Status', 7),
                            f('ResolveRecipients', 'CertificateCount', 0),
                            f('ResolveRecipients', 'RecipientCount', 1)
                        )
                    );
                recipients.push(
                    n(
                        'ResolveRecipients:Recipient',
                        f('ResolveRecipients', 'Type', entry.personal ? 2 : 1),
                        f('ResolveRecipients', 'DisplayName', entry.name),
                        f('ResolveRecipients', 'EmailAddress', entry.email),
                        extra
                    )
                );
            }
            responses.push(
                n(
                    'ResolveRecipients:Response',
                    f('ResolveRecipients', 'To', text),
                    f(
                        'ResolveRecipients',
                        'Status',
                        entries.length ? (entries.length > 1 ? (entries.length > max ? 3 : 2) : 1) : 4
                    ),
                    f('ResolveRecipients', 'RecipientCount', recipients.length),
                    recipients
                )
            );
        }
        return n('ResolveRecipients:ResolveRecipients', f('ResolveRecipients', 'Status', 1), responses);
    }
}
module.exports = { SearchService };
