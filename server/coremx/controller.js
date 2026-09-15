'use strict';
const crypto = require('node:crypto');
const { address } = require('./mail');
module.exports = {
    api: true,
    async handler(common, handle, request) {
        const mail = common.coremxMail;
        if (!mail || mail.store.failed) return { status: 503, payload: { msg: 'Mail service unavailable' } };
        const principal = request.thisdevice;
        if (!principal?.user?.eguid || principal.assurance !== 'webauthn_uv')
            return { status: 403, payload: { msg: 'Sign in with a passkey to manage mail' } };
        // Re-read the session to avoid granting administrative mutations from cached revoked tokens.
        const session = await common.dbmgr.findSingle('auth', { eguid: principal.eguid });
        if (!session || session.revoked || session.deleted || session.assurance !== 'webauthn_uv')
            return { status: 403, payload: { msg: 'Passkey session required' } };
        const userId = principal.user.eguid;
        const admin = await common.registration.isMasterCompanyAdmin(common, userId);
        const data = request.Payload.data || {};
        const owned = (id) => {
            const m = mail.store.get('mailboxes', id);
            if (!m || (!admin && m.owner !== userId)) throw new Error('Mailbox unavailable');
            return m;
        };
        try {
            let result;
            if (handle.startsWith('mail.')) {
                const mailbox = mail.store.get('mailboxes', data.mailbox);
                if (!mailbox?.enabled || mailbox.owner !== userId) throw new Error('Mailbox unavailable');
                result = await new (require('./webmail').Webmail)(mail, {
                    mailbox,
                    device: { id: 'web:' + userId },
                    protocolVersion: '16.1'
                }).handle(handle.slice(5), data);
            } else if (handle === 'list') {
                const mailboxes = mail.store.list('mailboxes', (m) => admin || m.owner === userId);
                result = {
                    mailboxes,
                    ownedMailboxes: mailboxes.filter((m) => m.owner === userId),
                    admin,
                    users: admin
                        ? (await common.dbmgr.findMany('users', {})).map((u) => ({
                              id: u.eguid,
                              label: u.name ? `${u.name} (${u.email || ''})` : u.email || 'Unnamed user'
                          }))
                        : [],
                    domains: admin ? mail.store.list('domains') : [],
                    aliases: admin ? mail.store.list('aliases') : [],
                    devices: mail.store
                        .list('devices', (d) => mailboxes.some((m) => m.id === d.mailbox))
                        .map(({ verifier, ...device }) => device),
                    protocol: { experimental: true, versions: ['14.1', '16.0', '16.1'] }
                };
            } else if (handle === 'createDomain' && admin) {
                const domain = String(data.domain || '').toLowerCase();
                address('postmaster@' + domain);
                const id = crypto.createHash('sha256').update(domain).digest('hex');
                await mail.store.transaction('domain:' + id, () => [
                    { collection: 'domains', id, value: { name: domain } }
                ]);
                result = { domain };
            } else if (handle === 'createMailbox' && admin) {
                const user = await common.dbmgr.findSingle('users', { eguid: data.owner });
                if (!user) throw new Error('Central user required');
                result = await mail.createMailbox(data);
            } else if (handle === 'createAlias' && admin) {
                const email = address(data.email);
                const target = mail.mailbox(data.target);
                if (!target) throw new Error('Target mailbox required');
                if (!mail.store.list('domains', (d) => d.name === email.split('@')[1]).length)
                    throw new Error('Domain not configured');
                if (mail.mailbox(email)) throw new Error('Address already exists');
                const id = crypto.randomUUID();
                await mail.store.transaction('alias:' + id, () => [
                    { collection: 'aliases', id, value: { email, target: target.email } }
                ]);
                result = { id };
            } else if (handle === 'issueDevice')
                result = await mail.issueDevice(owned(data.mailbox), data.label);
            else if (handle === 'revokeDevice') {
                const device = mail.store.get('devices', data.device);
                if (!device) throw new Error('Device unavailable');
                owned(device.mailbox);
                await mail.revokeDevice(device.id);
                result = { revoked: true };
            } else if (handle === 'requestAccountWipe') {
                const device = mail.store.get('devices', data.device);
                if (!device) throw new Error('Device unavailable');
                owned(device.mailbox);
                result = await mail.policy.requestWipe(device.id, userId);
            } else if (handle === 'setDevicePolicy' && admin) {
                const mailbox = owned(data.mailbox);
                const policy = require('./policy').normalize(data.policy);
                await mail.store.transaction('policy-config:' + crypto.randomUUID(), (store) => [
                    {
                        collection: 'mailboxes',
                        id: mailbox.id,
                        value: { ...store.get('mailboxes', mailbox.id), devicePolicy: policy }
                    }
                ]);
                result = { policy };
            } else if (handle === 'updateMailbox' && admin) {
                const mailbox = owned(data.mailbox);
                const quota = Number(data.quotaBytes);
                if (!Number.isSafeInteger(quota) || quota < 1) throw new Error('Invalid quota');
                await mail.store.transaction('mailbox-update:' + crypto.randomUUID(), () => [
                    {
                        collection: 'mailboxes',
                        id: mailbox.id,
                        value: { ...mailbox, enabled: data.enabled !== false, quotaBytes: quota }
                    }
                ]);
                result = { updated: true };
            } else return { status: 403, payload: { msg: 'Operation unavailable' } };
            if (handle !== 'list' && !handle.startsWith('mail.'))
                await mail.store.transaction('audit:' + crypto.randomUUID(), () => [
                    {
                        collection: 'audit',
                        id: crypto.randomUUID(),
                        value: { user: userId, action: handle, at: new Date().toISOString() }
                    }
                ]);
            return { status: 100, payload: result };
        } catch (error) {
            return { status: 400, payload: { msg: error.message } };
        }
    }
};
