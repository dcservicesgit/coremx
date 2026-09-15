'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const controller = require('../server/coremx/controller');
function fixture() {
    let issued = 0;
    const box = { id: 'box', owner: 'alice' };
    const common = {
        coremxMail: {
            store: { failed: false, get: () => box, transaction: async () => {} },
            issueDevice: async () => {
                issued++;
                return { id: 'device', secret: 'one-time' };
            }
        },
        dbmgr: { findSingle: async () => ({ eguid: 'session', assurance: 'webauthn_uv' }) },
        registration: { isMasterCompanyAdmin: async () => false }
    };
    const request = {
        thisdevice: { eguid: 'session', user: { eguid: 'alice' }, assurance: 'webauthn_uv' },
        Payload: { data: { mailbox: 'box' } }
    };
    return {
        common,
        request,
        get issued() {
            return issued;
        }
    };
}
test('mail administration requires fresh passkey assurance and ignores caller admin flags', async () => {
    const f = fixture();
    f.request.thisdevice.assurance = undefined;
    assert.equal((await controller.handler(f.common, 'issueDevice', f.request)).status, 403);
    assert.equal(f.issued, 0);
    f.request.thisdevice.assurance = 'webauthn_uv';
    f.common.dbmgr.findSingle = async () => ({ assurance: 'webauthn_uv', revoked: true });
    assert.equal((await controller.handler(f.common, 'issueDevice', f.request)).status, 403);
    assert.equal(f.issued, 0);
    f.common.dbmgr.findSingle = async () => ({ assurance: 'webauthn_uv' });
    f.request.thisdevice.user.eguid = 'mallory';
    f.request.thisdevice.admin = true;
    assert.equal((await controller.handler(f.common, 'issueDevice', f.request)).status, 400);
    assert.equal(f.issued, 0);
});
test('mailbox owner can issue a device credential after passkey verification', async () => {
    const f = fixture();
    const result = await controller.handler(f.common, 'issueDevice', f.request);
    assert.equal(result.status, 100);
    assert.equal(f.issued, 1);
});

test('webmail ownership is enforced even for organization administrators', async () => {
    const f = fixture();
    f.common.registration.isMasterCompanyAdmin = async () => true;
    f.request.thisdevice.user.eguid = 'mallory';
    const result = await controller.handler(f.common, 'mail.read', f.request);
    assert.equal(result.status, 400);
    assert.equal(result.payload.msg, 'Mailbox unavailable');
    f.common.dbmgr.findSingle = async () => ({ assurance: 'webauthn_uv', revoked: true });
    assert.equal((await controller.handler(f.common, 'mail.read', f.request)).status, 403);
});
