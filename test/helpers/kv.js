'use strict';
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const EncryptedKV = require('../../server/coremx/central')('modules/encryptedkv');

// Exercise Central's real JSON, compression, HMAC-key and encryption paths.
// Only its transport is replaced with an in-memory server holding ciphertext.
class TestKV extends EncryptedKV {
    constructor({ backend = new Map(), key } = {}) {
        super({ gek: key || { key: crypto.randomBytes(32).toString('base64'), method: 'aes-256-gcm' } });
        this.backend = backend;
    }
    _ensureWSClient() {}
    _initReadPool() {}
    _getReadSocketState() { return null; }
    async _wsClientRequest({ action, key, value, index }) {
        assert.notEqual(index, true, 'mail data must use encrypted values and HMAC keys');
        if (action === 'get') return this.backend.get(key) ?? null;
        if (action === 'set') { this.backend.set(key, value); return; }
        if (action === 'del') { this.backend.delete(key); return; }
        throw new Error('Unexpected KV action: ' + action);
    }
}
module.exports = options => new TestKV(options);
