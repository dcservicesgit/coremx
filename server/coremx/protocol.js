'use strict';
const { node: n } = require('./wbxml');
const versions = ['14.1', '16.0', '16.1'];
const namespaces = {
    FolderSync: 'FolderHierarchy',
    FolderCreate: 'FolderHierarchy',
    FolderUpdate: 'FolderHierarchy',
    FolderDelete: 'FolderHierarchy',
    Sync: 'AirSync',
    SendMail: 'ComposeMail',
    SmartReply: 'ComposeMail',
    SmartForward: 'ComposeMail',
    MoveItems: 'Move'
};
const rootName = (command) => `${namespaces[command] || command}:${command}`;
const error = (command, status) =>
    n(rootName(command), n((namespaces[command] || command) + ':Status', String(status)));
const v16 = new Set(
    'Calendar:ClientUid AirSyncBase:Add AirSyncBase:Delete AirSyncBase:ClientId AirSyncBase:Content AirSyncBase:Location AirSyncBase:InstanceId Email2:IsDraft Email2:Bcc Email2:Send MeetingResponse:SendResponse'.split(
        ' '
    )
);
function validateVersion(root, version) {
    const walk = (element) => {
        if (!element?.name) return;
        if (
            (version === '14.1' && v16.has(element.name)) ||
            (version !== '16.1' &&
                (element.name.startsWith('Find:') ||
                    [
                        'MeetingResponse:ProposedStartTime',
                        'MeetingResponse:ProposedEndTime',
                        'Provision:AccountOnlyRemoteWipe'
                    ].includes(element.name)))
        )
            throw Object.assign(new Error('Element unavailable in this version'), { easStatus: 138 });
        for (const child of element.children || []) walk(child);
    };
    walk(root);
}
function query(url, headers = {}) {
    if (url.searchParams.has('Cmd') || !url.search)
        return {
            command: url.searchParams.get('Cmd'),
            deviceId: url.searchParams.get('DeviceId'),
            deviceType: url.searchParams.get('DeviceType'),
            version: headers['ms-asprotocolversion'],
            policyKey: headers['x-ms-policykey'],
            multipart: headers['ms-asacceptmultipart'] === 'T'
        };
    const encoded = decodeURIComponent(url.search.slice(1));
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Invalid packed query');
    const bytes = Buffer.from(encoded, 'base64');
    let offset = 0;
    const read = (length) => {
        if (offset + length > bytes.length) throw new Error('Truncated packed query');
        const data = bytes.subarray(offset, offset + length);
        offset += length;
        return data;
    };
    const byte = () => read(1)[0];
    const versionCode = byte();
    const commandCode = byte();
    read(2);
    const command = {
        0: 'Sync',
        1: 'SendMail',
        2: 'SmartForward',
        3: 'SmartReply',
        9: 'FolderSync',
        10: 'FolderCreate',
        11: 'FolderDelete',
        12: 'FolderUpdate',
        13: 'MoveItems',
        14: 'GetItemEstimate',
        15: 'MeetingResponse',
        16: 'Search',
        17: 'Settings',
        18: 'Ping',
        19: 'ItemOperations',
        20: 'Provision',
        21: 'ResolveRecipients',
        22: 'ValidateCert',
        23: 'Find'
    }[commandCode];
    const deviceId = read(byte()).toString('ascii');
    const keyLength = byte();
    if (![0, 4].includes(keyLength)) throw new Error('Invalid policy key');
    const policyKey = keyLength ? String(read(4).readUInt32LE()) : '0';
    const deviceType = read(byte()).toString('ascii');
    let multipart = false;
    while (offset < bytes.length) {
        const tag = byte();
        const data = read(byte());
        if (tag === 7) {
            if (data.length !== 1) throw new Error('Invalid options');
            multipart = !!(data[0] & 2);
        }
    }
    if (!deviceId || !deviceType || !command) throw new Error('Invalid packed query');
    return { command, deviceId, deviceType, policyKey, version: (versionCode / 10).toFixed(1), multipart };
}
module.exports = { versions, rootName, error, validateVersion, query };
const rootFields = {
    FolderSync: ['FolderHierarchy:SyncKey'],
    FolderCreate: [
        'FolderHierarchy:SyncKey',
        'FolderHierarchy:ParentId',
        'FolderHierarchy:DisplayName',
        'FolderHierarchy:Type'
    ],
    FolderUpdate: [
        'FolderHierarchy:SyncKey',
        'FolderHierarchy:ServerId',
        'FolderHierarchy:ParentId',
        'FolderHierarchy:DisplayName'
    ],
    FolderDelete: ['FolderHierarchy:SyncKey', 'FolderHierarchy:ServerId'],
    Sync: 'Collections Wait HeartbeatInterval Partial WindowSize'.split(' ').map((k) => 'AirSync:' + k),
    Ping: ['Ping:HeartbeatInterval', 'Ping:Folders'],
    GetItemEstimate: ['GetItemEstimate:Collections'],
    MoveItems: ['Move:Move'],
    ItemOperations: ['ItemOperations:Fetch', 'ItemOperations:EmptyFolderContents', 'ItemOperations:Move'],
    Search: ['Search:Store'],
    Find: ['Find:SearchId', 'Find:ExecuteSearch'],
    ResolveRecipients: ['ResolveRecipients:To', 'ResolveRecipients:Options'],
    MeetingResponse: ['MeetingResponse:Request'],
    Settings: [
        'Settings:DeviceInformation',
        'Settings:UserInformation',
        'Settings:Oof',
        'Settings:DevicePassword',
        'Settings:RightsManagementInformation'
    ],
    Provision: ['Provision:Policies', 'Provision:AccountOnlyRemoteWipe', 'Settings:DeviceInformation']
};
for (const command of ['SendMail', 'SmartReply', 'SmartForward'])
    rootFields[command] = 'ClientId SaveInSentItems ReplaceMime Source Mime AccountId Forwardees'
        .split(' ')
        .map((k) => 'ComposeMail:' + k)
        .concat(['AirSyncBase:Body']);
module.exports.validateRoot = (command, root) => {
    if (!root) return;
    const allowed = rootFields[command],
        seen = new Set();
    for (const item of root.children) {
        if (
            !item?.name ||
            !allowed?.includes(item.name) ||
            (seen.has(item.name) &&
                ![
                    'ResolveRecipients:To',
                    'MeetingResponse:Request',
                    'Move:Move',
                    'ItemOperations:Fetch',
                    'ItemOperations:EmptyFolderContents',
                    'ItemOperations:Move'
                ].includes(item.name))
        )
            throw Object.assign(new Error('Invalid command structure'), { easStatus: 103 });
        seen.add(item.name);
    }
};
