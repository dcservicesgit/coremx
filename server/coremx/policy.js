'use strict';
const crypto = require('node:crypto');
const { node: n, child, value, tables } = require('./wbxml');
const f = (key, text) => n('Provision:' + key, String(text));
const booleanNames = new Set(
    'DevicePasswordEnabled AlphanumericDevicePasswordRequired RequireStorageCardEncryption PasswordRecoveryEnabled AttachmentsEnabled AllowSimpleDevicePassword AllowStorageCard AllowCamera RequireDeviceEncryption AllowUnsignedApplications AllowUnsignedInstallationPackages AllowWiFi AllowTextMessaging AllowPOPIMAPEmail AllowIrDA RequireManualSyncWhenRoaming AllowDesktopSync AllowHTMLEmail RequireSignedSMIMEMessages RequireEncryptedSMIMEMessages AllowSMIMESoftCerts AllowBrowser AllowConsumerEmail AllowRemoteDesktop AllowInternetSharing'.split(
        ' '
    )
);
const numericNames = new Set(
    'MinDevicePasswordLength MaxInactivityTimeDeviceLock MaxDevicePasswordFailedAttempts MaxAttachmentSize DevicePasswordExpiration DevicePasswordHistory MinDevicePasswordComplexCharacters AllowBluetooth MaxCalendarAgeFilter MaxEmailAgeFilter MaxEmailBodyTruncationSize MaxEmailHTMLBodyTruncationSize RequireSignedSMIMEAlgorithm RequireEncryptionSMIMEAlgorithm AllowSMIMEEncryptionAlgorithmNegotiation'.split(
        ' '
    )
);
const defaults = {
    DevicePasswordEnabled: 1,
    AlphanumericDevicePasswordRequired: 0,
    MinDevicePasswordLength: 6,
    MaxInactivityTimeDeviceLock: 900,
    MaxDevicePasswordFailedAttempts: 10,
    AllowSimpleDevicePassword: 0,
    PasswordRecoveryEnabled: 0,
    AttachmentsEnabled: 1,
    MaxAttachmentSize: 33554432,
    AllowHTMLEmail: 1,
    MaxEmailAgeFilter: 0,
    MaxCalendarAgeFilter: 0
};
function normalize(input = {}) {
    const policy = { ...defaults, ...input };
    for (const [name, setting] of Object.entries(policy)) {
        if (booleanNames.has(name)) {
            if (![true, false, 0, 1].includes(setting)) throw new Error('Invalid policy: ' + name);
            policy[name] = Number(setting);
        } else if (numericNames.has(name)) {
            if (!Number.isSafeInteger(setting) || setting < 0 || setting > 0xffffffff)
                throw new Error('Invalid policy: ' + name);
        } else if (['UnapprovedInROMApplicationList', 'ApprovedApplicationList'].includes(name)) {
            if (
                !Array.isArray(setting) ||
                setting.length > 100 ||
                setting.some((s) => typeof s !== 'string' || s.length > 512)
            )
                throw new Error('Invalid application policy');
        } else throw new Error('Unknown provisioning policy: ' + name);
    }
    if (
        policy.MinDevicePasswordLength > 16 ||
        policy.MinDevicePasswordComplexCharacters > 4 ||
        policy.AllowBluetooth > 2 ||
        policy.MaxEmailAgeFilter > 5 ||
        policy.MaxCalendarAgeFilter > 7
    )
        throw new Error('Policy value outside protocol range');
    if (policy.PasswordRecoveryEnabled) throw new Error('Device password recovery is not supported');
    return policy;
}
const fingerprint = (policy) =>
    crypto
        .createHash('sha256')
        .update(JSON.stringify(Object.entries(policy).sort(([a], [b]) => a.localeCompare(b))))
        .digest('hex');
class PolicyService {
    constructor(mail) {
        this.mail = mail;
        this.store = mail.store;
    }
    current(auth) {
        return normalize({
            ...(this.mail.configuration?.devicePolicy || {}),
            ...(this.store.get('mailboxes', auth.mailbox.id)?.devicePolicy || {})
        });
    }
    check(auth, suppliedKey, version) {
        const device = this.store.get('devices', auth.device.id);
        if (!device || device.revoked) return 126;
        if (device.wipe?.status === 'pending' || device.wipe?.status === 'delivered')
            return version === '16.1' ? 140 : 139;
        if (!device.policyKey) return 142;
        if (device.policyFingerprint !== fingerprint(this.current(auth))) return 144;
        if (String(suppliedKey || '0') !== device.policyKey) return 144;
        const age = this.mail.configuration?.policyRefreshHours || 24;
        if (Date.now() - Date.parse(device.provisionedAt || 0) > age * 3600000) return 143;
        return null;
    }
    async provision(root, auth, version) {
        const deviceId = auth.device.id;
        let result;
        await this.store.transaction('provision:' + crypto.randomUUID(), (store) => {
            const device = store.get('devices', deviceId);
            if (!device || device.revoked) throw new Error('Device unavailable');
            const information = child(child(root, 'Settings:DeviceInformation'), 'Settings:Set');
            if (information && Buffer.byteLength(JSON.stringify(information)) > 8192)
                throw new Error('Invalid device information');
            const update = (data) => [
                {
                    collection: 'devices',
                    id: deviceId,
                    value: {
                        ...device,
                        ...(information ? { information: information.children } : {}),
                        ...data
                    }
                }
            ];
            if (device.wipe && ['pending', 'delivered'].includes(device.wipe.status)) {
                if (version !== '16.1') {
                    result = n('Provision:Provision', f('Status', 139));
                    return [];
                }
                const acknowledgement = child(root, 'Provision:AccountOnlyRemoteWipe');
                if (acknowledgement) {
                    if (value(acknowledgement, 'Provision:Status') !== '1') {
                        result = n('Provision:Provision', f('Status', 2));
                        return [];
                    }
                    result = n('Provision:Provision', f('Status', 1));
                    return update({
                        revoked: true,
                        policyKey: null,
                        wipe: {
                            ...device.wipe,
                            status: 'acknowledged',
                            acknowledgedAt: new Date().toISOString()
                        }
                    });
                }
                result = n('Provision:Provision', f('Status', 1), n('Provision:AccountOnlyRemoteWipe'));
                return update({
                    wipe: {
                        ...device.wipe,
                        status: 'delivered',
                        deliveredAt: device.wipe.deliveredAt || new Date().toISOString()
                    }
                });
            }
            const requested = child(child(root, 'Provision:Policies'), 'Provision:Policy');
            const type = value(requested, 'Provision:PolicyType');
            const wrap = (status, key, data) =>
                n(
                    'Provision:Provision',
                    f('Status', 1),
                    n(
                        'Provision:Policies',
                        n(
                            'Provision:Policy',
                            f('PolicyType', type),
                            f('Status', status),
                            key ? f('PolicyKey', key) : null,
                            data
                        )
                    )
                );
            if (type !== 'MS-EAS-Provisioning-WBXML') {
                result = wrap(2);
                return [];
            }
            const policy = this.current(auth);
            const digest = fingerprint(policy);
            if (child(requested, 'Provision:Status')) {
                const key = value(requested, 'Provision:PolicyKey');
                if (
                    device.lastAcknowledgedPolicy === key &&
                    device.policyFingerprint === digest &&
                    value(requested, 'Provision:Status') === '1'
                ) {
                    result = wrap(1, device.policyKey);
                    return [];
                }
                if (
                    !key ||
                    key !== device.pendingPolicy?.key ||
                    digest !== device.pendingPolicy?.fingerprint
                ) {
                    result = wrap(5);
                    return [];
                }
                if (value(requested, 'Provision:Status') !== '1') {
                    result = wrap(4);
                    return update({
                        pendingPolicy: null,
                        policyKey: null,
                        policyFailure: value(requested, 'Provision:Status')
                    });
                }
                const finalKey = String(crypto.randomInt(1, 0xffffffff));
                result = wrap(1, finalKey);
                return update({
                    policyKey: finalKey,
                    policyFingerprint: digest,
                    provisionedAt: new Date().toISOString(),
                    pendingPolicy: null,
                    lastAcknowledgedPolicy: key,
                    policyFailure: null
                });
            }
            const pending =
                device.pendingPolicy?.fingerprint === digest
                    ? device.pendingPolicy
                    : { key: String(crypto.randomInt(1, 0xffffffff)), fingerprint: digest };
            // Emit policy fields in protocol order; device acknowledgement is required
            // before the final key authorizes data access.
            const order = tables[14][1].split(' ');
            const fields = Object.entries(policy)
                .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
                .map(([name, setting]) =>
                    Array.isArray(setting)
                        ? n(
                              'Provision:' + name,
                              setting.map((v) =>
                                  f(name === 'ApprovedApplicationList' ? 'Hash' : 'ApplicationName', v)
                              )
                          )
                        : f(name, setting)
                );
            result = wrap(1, pending.key, n('Provision:Data', n('Provision:EASProvisionDoc', fields)));
            return update({ pendingPolicy: pending });
        });
        return result;
    }
    async requestWipe(deviceId, actor) {
        await this.store.transaction('account-wipe:' + crypto.randomUUID(), (store) => {
            const device = store.get('devices', deviceId);
            if (!device || device.revoked) throw new Error('Device unavailable');
            if (device.protocolVersion !== '16.1')
                throw new Error('Account-only wipe requires a connected EAS 16.1 device');
            return [
                {
                    collection: 'devices',
                    id: deviceId,
                    value: {
                        ...device,
                        wipe: { status: 'pending', requestedAt: new Date().toISOString(), requestedBy: actor }
                    }
                }
            ];
        });
        return { pending: true };
    }
    filterOptions(auth, options, type) {
        const policy = this.current(auth);
        const maxAge = type === 'Calendar' ? policy.MaxCalendarAgeFilter : policy.MaxEmailAgeFilter;
        const selected = { ...options, preferences: options.preferences?.map((p) => ({ ...p })) || [] };
        if (['Email', 'Calendar'].includes(type) && maxAge && (!selected.filter || selected.filter > maxAge))
            selected.filter = maxAge;
        if (!policy.AllowHTMLEmail) selected.preferences = selected.preferences.filter((p) => p.type !== 2);
        if (
            !policy.AttachmentsEnabled ||
            !policy.AllowHTMLEmail ||
            policy.MaxEmailBodyTruncationSize !== undefined ||
            policy.MaxAttachmentSize < 33554432
        ) {
            selected.mime = 0;
            selected.preferences = selected.preferences.filter((p) => p.type !== 4);
        }
        selected.attachmentsEnabled = !!policy.AttachmentsEnabled;
        selected.maxAttachmentSize = policy.MaxAttachmentSize;
        if (!selected.preferences.length) selected.preferences = [{ type: 1, size: 4096, preview: 0 }];
        if (!policy.AllowHTMLEmail) selected.part = undefined;
        else if (selected.part) selected.part = { ...selected.part };
        for (const preference of [...selected.preferences, ...(selected.part ? [selected.part] : [])]) {
            const cap =
                preference.type === 2
                    ? policy.MaxEmailHTMLBodyTruncationSize
                    : policy.MaxEmailBodyTruncationSize;
            if (cap !== undefined && cap !== 0xffffffff)
                preference.size = Math.min(preference.size ?? 0xffffffff, cap);
        }
        return selected;
    }
}
module.exports = { PolicyService, normalize, fingerprint };
