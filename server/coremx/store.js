'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const CHUNK = 256 * 1024;
const LIMIT = 32 * 1024 * 1024;
const IO_CONCURRENCY = 4;
const PREFIX = 'coremx:v2:';
const HEAD = PREFIX + 'head';
const journalKey = sequence => PREFIX + 'journal:' + sequence;
const blobKey = (blob, part) => PREFIX + 'blobs:' + blob + ':' + part;
const MAILBOX_KINDS = new Set([
    'folders',
    'messages',
    'outbox',
    'hierarchy',
    'sync',
    'syncReplies',
    'ping',
    'pimOperations',
    'clientState',
    'searches',
    'preferences',
    'uploads',
    'calendarHistory'
]);
const id = () => crypto.randomUUID();
const digest = (b) => crypto.createHash('sha256').update(b).digest('hex');
function validId(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
        throw new Error('Invalid object identifier');
    return value;
}
// One physical collection per mailbox. Logical record types share that collection,
// never a global message list. IDs remain unchanged on the wire.
class MailboxCollection {
    constructor(store, mailbox) {
        this.store = store;
        this.mailbox = validId(mailbox);
        this.collection = validId('mailbox_' + mailbox);
    }
    unpack(value) {
        if (!value) return null;
        const { kind, recordId, ...record } = value;
        return { ...record, id: recordId };
    }
    get(kind, id) {
        if (MAILBOX_KINDS.has(kind)) return this.unpack(this.store.get(this.collection, `${kind}_${id}`));
        const record = this.store.get(kind, id);
        if (kind === 'mailboxes' && id === this.mailbox) return record;
        if (kind === 'devices' && record?.mailbox === this.mailbox) return record;
        throw new Error('Record outside mailbox collection');
    }
    list(kind, predicate = () => true) {
        if (!MAILBOX_KINDS.has(kind)) throw new Error('Mailbox record type required');
        return this.store
            .list(this.collection, (record) => record.kind === kind)
            .map((record) => this.unpack(record))
            .filter(predicate);
    }
    change({ collection: kind, id, value, ...rest }) {
        if (!MAILBOX_KINDS.has(kind)) {
            if (kind !== 'mailboxes' && kind !== 'devices')
                throw new Error('Record outside mailbox collection');
            if (
                kind === 'mailboxes'
                    ? id !== this.mailbox
                    : (value?.mailbox || this.store.get(kind, id)?.mailbox) !== this.mailbox
            )
                throw new Error('Record outside mailbox collection');
            return { ...rest, collection: kind, id, value };
        }
        validId(id);
        if (value?.mailbox && value.mailbox !== this.mailbox)
            throw new Error('Record outside mailbox collection');
        return {
            ...rest,
            collection: this.collection,
            id: validId(`${kind}_${id}`),
            value: value === null ? null : { ...value, kind, recordId: id, mailbox: this.mailbox }
        };
    }
    transaction(operation, build) {
        return this.store.transaction(operation, async () =>
            (await build(this)).map((change) => this.change(change))
        );
    }
}
// Wait for the whole batch before propagating a failure, so no writes outlive it.
async function batch(count, work) {
    for (let start = 0; start < count; start += IO_CONCURRENCY) {
        const results = await Promise.allSettled(
            Array.from({ length: Math.min(IO_CONCURRENCY, count - start) }, (_, offset) => work(start + offset))
        );
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
    }
}
class MailStore extends EventEmitter {
    constructor({ runDirectory, kv }) {
        super();
        if (!kv || typeof kv.get !== 'function' || typeof kv.set !== 'function' || kv.ekvserver)
            throw new Error('CoreMX requires an encryptedkv client');
        this.runDirectory = path.resolve(runDirectory);
        this.kv = kv;
        this.records = new Map();
        this.operations = new Map();
        this.sequence = 0;
        this.previous = '';
        this.tail = Promise.resolve();
        this.blobWrites = new Set();
        this.failed = false;
        this.closing = false;
    }
    async open() {
        // Only process coordination lives on disk; every mail record is in encryptedkv.
        // The deployment runs one application worker against this KV namespace.
        await fs.mkdir(this.runDirectory, { recursive: true, mode: 0o700 });
        this.lockPath = path.join(this.runDirectory, 'coremx-writer.lock');
        try {
            this.lock = await fs.open(this.lockPath, 'wx', 0o600);
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const pid = Number(await fs.readFile(this.lockPath, 'utf8'));
            if (!Number.isSafeInteger(pid) || pid <= 1)
                throw new Error('Invalid writer lock; operator inspection required');
            try {
                process.kill(pid, 0);
                throw new Error('Mailbox writer already running');
            } catch (e) {
                if (e.code !== 'ESRCH') throw e;
            }
            await fs.unlink(this.lockPath);
            this.lock = await fs.open(this.lockPath, 'wx', 0o600);
        }
        try {
            await this.lock.writeFile(String(process.pid));
            const head = await this.kv.get(HEAD);
            if (head !== null && head !== undefined && (
                head.version !== 1 || !Number.isSafeInteger(head.sequence) || head.sequence < 1 ||
                typeof head.digest !== 'string' || !/^[a-f0-9]{64}$/.test(head.digest)
            )) throw new Error('Invalid journal head');
            let last;
            for (let sequence = 1; sequence <= (head?.sequence || 0); sequence++) {
                const record = await this.kv.get(journalKey(sequence));
                if (!record) throw new Error('Journal was truncated');
                this.validateRecord(record);
                if (record.sequence !== sequence || record.previous !== this.previous)
                    throw new Error('Journal integrity failure');
                // Replay only into memory. Historical KV projections need no rewrites.
                await this.apply(record, false);
                this.previous = digest(JSON.stringify(record));
                last = record;
            }
            if (head && head.digest !== this.previous) throw new Error('Journal head integrity failure');
            // Only the final committed transaction can have an incomplete projection.
            if (last) await this.apply(last);
        } catch (error) {
            await this.close();
            throw error;
        }
        return this;
    }
    get(collection, key) {
        return structuredClone(this.records.get(collection)?.get(key) ?? null);
    }
    forMailbox(mailbox) {
        return new MailboxCollection(this, mailbox);
    }
    list(collection, predicate = () => true) {
        return [...(this.records.get(collection)?.values() || [])]
            .filter(predicate)
            .map((v) => structuredClone(v));
    }
    validateRecord(record) {
        if (record.version !== 1 || !Number.isSafeInteger(record.sequence) || record.sequence < 1 ||
            typeof record.operation !== 'string' || !record.operation || record.operation.length > 512 ||
            !Array.isArray(record.changes) || record.changes.length > 1000)
            throw new Error('Invalid transaction');
        if (Buffer.byteLength(JSON.stringify(record)) > 3 * 1024 * 1024)
            throw new Error('Transaction too large');
        for (const change of record.changes) {
            validId(change.collection);
            validId(change.id);
            if (change.preserveRevision !== undefined ||
                (change.value !== null && (!change.value || typeof change.value !== 'object' || Array.isArray(change.value))))
                throw new Error('Invalid record value');
        }
    }
    async apply(record, project = true) {
        for (const change of record.changes) {
            if (!this.records.has(change.collection)) this.records.set(change.collection, new Map());
            const value = change.value === null ? null : { ...change.value, id: change.id, revision: record.sequence };
            if (project) await this.kv.set(
                `${PREFIX}${change.collection}:${change.id}`,
                value ?? { deleted: true, revision: record.sequence }
            );
            if (value === null) this.records.get(change.collection).delete(change.id);
            else this.records.get(change.collection).set(change.id, value);
        }
        this.sequence = record.sequence;
        this.operations.set(record.operation, record.sequence);
    }
    transaction(operation, build) {
        if (this.closing) return Promise.reject(new Error('Mailbox writer unavailable'));
        if (typeof operation !== 'string' || !operation || operation.length > 512)
            return Promise.reject(new Error('Invalid operation id'));
        const pending = this.tail.then(async () => {
            if (this.failed || !this.lock) throw new Error('Mailbox writer unavailable');
            if (this.operations.has(operation)) return this.operations.get(operation);
            const changes = await build(this);
            const record = {
                version: 1,
                sequence: this.sequence + 1,
                previous: this.previous,
                operation,
                at: new Date().toISOString(),
                changes
            };
            this.validateRecord(record);
            // Snapshot JSON exactly as encryptedkv serializes it, before any async writes.
            const serialized = JSON.stringify(record);
            const committed = JSON.parse(serialized);
            const hash = digest(serialized);
            try {
                await this.kv.set(journalKey(record.sequence), committed);
                // The head is the commit point. Uncommitted journal tails are ignored on restart.
                await this.kv.set(HEAD, { version: 1, sequence: record.sequence, digest: hash });
                await this.apply(committed);
                this.previous = hash;
            } catch (error) {
                // A failed acknowledgement may still have persisted. Reopen before retrying.
                this.failed = true;
                this.emit('unavailable');
                throw error;
            }
            this.emit('change', committed);
            return record.sequence;
        });
        this.tail = pending.catch(() => {});
        return pending;
    }
    putBlob(bytes) {
        if (this.failed || !this.lock || this.closing)
            return Promise.reject(new Error('Mailbox writer unavailable'));
        if (!Buffer.isBuffer(bytes) || bytes.length > LIMIT)
            return Promise.reject(new Error('Message size limit'));
        const pending = this.writeBlob(bytes);
        this.blobWrites.add(pending);
        return pending.finally(() => this.blobWrites.delete(pending));
    }
    async writeBlob(bytes) {
        const blobId = id();
        const chunks = Math.ceil(bytes.length / CHUNK);
        const sha256 = digest(bytes);
        // Base64 preserves binary through KV's JSON API; KV handles compression/encryption once.
        await batch(chunks, index => this.kv.set(blobKey(blobId, `chunk:${index}`), {
            version: 1, blobId, index,
            data: bytes.subarray(index * CHUNK, (index + 1) * CHUNK).toString('base64')
        }));
        // Publish only after every chunk has been acknowledged.
        await this.kv.set(blobKey(blobId, 'manifest'), { version: 1, blobId, chunks, size: bytes.length, sha256 });
        return blobId;
    }
    async getBlob(blobId) {
        validId(blobId);
        const manifest = await this.kv.get(blobKey(blobId, 'manifest'));
        if (!manifest || manifest.version !== 1 || manifest.blobId !== blobId ||
            !Number.isSafeInteger(manifest.size) || manifest.size < 0 || manifest.size > LIMIT ||
            manifest.chunks !== Math.ceil(manifest.size / CHUNK) ||
            typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256))
            throw new Error('Invalid blob manifest');
        // One output allocation, plus at most four decoded chunks, instead of concatenating all chunks.
        const bytes = Buffer.allocUnsafe(manifest.size);
        await batch(manifest.chunks, async index => {
            const item = await this.kv.get(blobKey(blobId, `chunk:${index}`));
            if (!item || item.version !== 1 || item.blobId !== blobId || item.index !== index || typeof item.data !== 'string')
                throw new Error('Blob chunk identity mismatch');
            const expected = Math.min(CHUNK, manifest.size - index * CHUNK);
            if (item.data.length !== Math.ceil(expected / 3) * 4) throw new Error('Invalid blob chunk');
            const chunk = Buffer.from(item.data, 'base64');
            if (chunk.length !== expected || chunk.toString('base64') !== item.data)
                throw new Error('Invalid blob chunk');
            chunk.copy(bytes, index * CHUNK);
        });
        if (digest(bytes) !== manifest.sha256) throw new Error('Blob integrity failure');
        return bytes;
    }
    async close() {
        this.closing = true;
        await this.tail;
        await Promise.allSettled([...this.blobWrites]);
        if (this.lock) {
            await this.lock.close();
            this.lock = null;
            await fs.unlink(this.lockPath);
        }
    }
}
module.exports = { MailStore, validId, LIMIT };
