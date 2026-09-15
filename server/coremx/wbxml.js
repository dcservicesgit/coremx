'use strict';
// Token assignments are protocol data from Microsoft MS-ASWBXML, section 2.1.2.
const tables = {
    0: [
        'AirSync',
        'Sync Responses Add Change Delete Fetch SyncKey ClientId ServerId Status Collection Class - CollectionId GetChanges MoreAvailable WindowSize Commands Options FilterType - - Conflict Collections ApplicationData DeletesAsMoves - Supported SoftDelete MIMESupport MIMETruncation Wait Limit Partial ConversationMode MaxItems HeartbeatInterval'
    ],
    1: [
        'Contacts',
        'Anniversary AssistantName AssistantPhoneNumber Birthday - - - Business2PhoneNumber BusinessAddressCity BusinessAddressCountry BusinessAddressPostalCode BusinessAddressState BusinessAddressStreet BusinessFaxNumber BusinessPhoneNumber CarPhoneNumber Categories Category Children Child CompanyName Department Email1Address Email2Address Email3Address FileAs FirstName Home2PhoneNumber HomeAddressCity HomeAddressCountry HomeAddressPostalCode HomeAddressState HomeAddressStreet HomeFaxNumber HomePhoneNumber JobTitle LastName MiddleName MobilePhoneNumber OfficeLocation OtherAddressCity OtherAddressCountry OtherAddressPostalCode OtherAddressState OtherAddressStreet PagerNumber RadioPhoneNumber Spouse Suffix Title WebPage YomiCompanyName YomiFirstName YomiLastName - Picture Alias WeightedRank'
    ],
    2: [
        'Email',
        '- - - - - - - - - - DateReceived - DisplayTo Importance MessageClass Subject Read To Cc From ReplyTo AllDayEvent Categories Category DtStamp EndTime InstanceType BusyStatus Location MeetingRequest Organizer RecurrenceId Reminder ResponseRequested Recurrences Recurrence Type Until Occurrences Interval DayOfWeek DayOfMonth WeekOfMonth MonthOfYear StartTime Sensitivity TimeZone GlobalObjId ThreadTopic - - - InternetCPID Flag Status ContentClass FlagType CompleteTime DisallowNewTimeProposal'
    ],
    4: [
        'Calendar',
        'TimeZone AllDayEvent Attendees Attendee Email Name - - BusyStatus Categories Category - DtStamp EndTime Exception Exceptions Deleted ExceptionStartTime Location MeetingStatus OrganizerEmail OrganizerName Recurrence Type Until Occurrences Interval DayOfWeek DayOfMonth WeekOfMonth MonthOfYear Reminder Sensitivity Subject StartTime UID AttendeeStatus AttendeeType - - - - - - - - DisallowNewTimeProposal ResponseRequested AppointmentReplyTime ResponseType CalendarType IsLeapMonth FirstDayOfWeek OnlineMeetingConfLink OnlineMeetingExternalLink ClientUid'
    ],
    5: ['Move', 'MoveItems Move SrcMsgId SrcFldId DstFldId Response Status DstMsgId'],
    6: [
        'GetItemEstimate',
        'GetItemEstimate Version Collections Collection Class CollectionId DateTime Estimate Response Status'
    ],
    7: [
        'FolderHierarchy',
        '- - DisplayName ServerId ParentId Type - Status - Changes Add Delete Update SyncKey FolderCreate FolderDelete FolderUpdate FolderSync Count'
    ],
    8: [
        'MeetingResponse',
        'CalendarId CollectionId MeetingResponse RequestId Request Result Status UserResponse - InstanceId - ProposedStartTime ProposedEndTime SendResponse'
    ],
    9: [
        'Tasks',
        '- - - Categories Category Complete DateCompleted DueDate UtcDueDate Importance Recurrence Type Start Until Occurrences Interval DayOfMonth DayOfWeek WeekOfMonth MonthOfYear Regenerate DeadOccur ReminderSet ReminderTime Sensitivity StartDate UtcStartDate Subject - OrdinalDate SubOrdinalDate CalendarType IsLeapMonth FirstDayOfWeek'
    ],
    10: [
        'ResolveRecipients',
        'ResolveRecipients Response Status Type Recipient DisplayName EmailAddress Certificates Certificate MiniCertificate Options To CertificateRetrieval RecipientCount MaxCertificates MaxAmbiguousRecipients CertificateCount Availability StartTime EndTime MergedFreeBusy Picture MaxSize Data MaxPictures'
    ],
    11: ['ValidateCert', 'ValidateCert Certificates Certificate CertificateChain CheckCRL Status'],
    12: [
        'Contacts2',
        'CustomerId GovernmentId IMAddress IMAddress2 IMAddress3 ManagerName CompanyMainPhone AccountName NickName MMS'
    ],
    13: ['Ping', 'Ping AutdState Status HeartbeatInterval Folders Folder Id Class MaxFolders'],
    14: [
        'Provision',
        'Provision Policies Policy PolicyType PolicyKey Data Status RemoteWipe EASProvisionDoc DevicePasswordEnabled AlphanumericDevicePasswordRequired RequireStorageCardEncryption PasswordRecoveryEnabled - AttachmentsEnabled MinDevicePasswordLength MaxInactivityTimeDeviceLock MaxDevicePasswordFailedAttempts MaxAttachmentSize AllowSimpleDevicePassword DevicePasswordExpiration DevicePasswordHistory AllowStorageCard AllowCamera RequireDeviceEncryption AllowUnsignedApplications AllowUnsignedInstallationPackages MinDevicePasswordComplexCharacters AllowWiFi AllowTextMessaging AllowPOPIMAPEmail AllowBluetooth AllowIrDA RequireManualSyncWhenRoaming AllowDesktopSync MaxCalendarAgeFilter AllowHTMLEmail MaxEmailAgeFilter MaxEmailBodyTruncationSize MaxEmailHTMLBodyTruncationSize RequireSignedSMIMEMessages RequireEncryptedSMIMEMessages RequireSignedSMIMEAlgorithm RequireEncryptionSMIMEAlgorithm AllowSMIMEEncryptionAlgorithmNegotiation AllowSMIMESoftCerts AllowBrowser AllowConsumerEmail AllowRemoteDesktop AllowInternetSharing UnapprovedInROMApplicationList ApplicationName ApprovedApplicationList Hash AccountOnlyRemoteWipe'
    ],
    15: [
        'Search',
        'Search - Store Name Query Options Range Status Response Result Properties Total EqualTo Value And Or FreeText - DeepTraversal LongId RebuildResults LessThan GreaterThan - - UserName Password ConversationId Picture MaxSize MaxPictures'
    ],
    16: [
        'GAL',
        'DisplayName Phone Office Title Company Alias FirstName LastName HomePhone MobilePhone EmailAddress Picture Status Data'
    ],
    17: [
        'AirSyncBase',
        'BodyPreference Type TruncationSize AllOrNone - Body Data EstimatedDataSize Truncated Attachments Attachment DisplayName FileReference Method ContentId ContentLocation IsInline NativeBodyType ContentType Preview BodyPartPreference BodyPart Status Add Delete ClientId Content Location Annotation Street City State Country PostalCode Latitude Longitude Accuracy Altitude AltitudeAccuracy LocationUri InstanceId'
    ],
    18: [
        'Settings',
        'Settings Status Get Set Oof OofState StartTime EndTime OofMessage AppliesToInternal AppliesToExternalKnown AppliesToExternalUnknown Enabled ReplyMessage BodyType DevicePassword Password DeviceInformation Model IMEI FriendlyName OS OSLanguage PhoneNumber UserInformation EmailAddresses SMTPAddress UserAgent EnableOutboundSMS MobileOperator PrimarySmtpAddress Accounts Account AccountId AccountName UserDisplayName SendDisabled - RightsManagementInformation'
    ],
    19: [
        'DocumentLibrary',
        'LinkId DisplayName IsFolder CreationDate LastModifiedDate IsHidden ContentLength ContentType'
    ],
    20: [
        'ItemOperations',
        'ItemOperations Fetch Store Options Range Total Properties Data Status Response Version Schema Part EmptyFolderContents DeleteSubFolders UserName Password Move DstFldId ConversationId MoveAlways'
    ],
    21: [
        'ComposeMail',
        'SendMail SmartForward SmartReply SaveInSentItems ReplaceMime - Source FolderId ItemId LongId InstanceId Mime ClientId Status AccountId - Forwardees Forwardee Name Email'
    ],
    22: [
        'Email2',
        'UmCallerID UmUserNotes UmAttDuration UmAttOrder ConversationId ConversationIndex LastVerbExecuted LastVerbExecutionTime ReceivedAsBcc Sender CalendarType IsLeapMonth AccountId FirstDayOfWeek MeetingMessageType - IsDraft Bcc Send'
    ],
    23: ['Notes', 'Subject MessageClass LastModifiedDate Categories Category'],
    24: [
        'RightsManagement',
        'RightsManagementSupport RightsManagementTemplates RightsManagementTemplate RightsManagementLicense EditAllowed ReplyAllowed ReplyAllAllowed ForwardAllowed ModifyRecipientsAllowed ExtractAllowed PrintAllowed ExportAllowed ProgrammaticAccessAllowed Owner ContentExpiryDate TemplateID TemplateName TemplateDescription ContentOwner RemoveRightsManagementDistribution'
    ]
};
tables[25] = [
    'Find',
    'Find SearchId ExecuteSearch MailBoxSearchCriterion Query Status FreeText Options Range DeepTraversal - - Response Result Properties Preview HasAttachments Total DisplayCc DisplayBcc GalSearchCriterion - - - - - - MaxPictures MaxSize Picture'
];
const byName = new Map();
for (const [page, [namespace, tokens]] of Object.entries(tables))
    tokens.split(' ').forEach((name, index) => {
        if (name !== '-') byName.set(namespace + ':' + name, { page: Number(page), token: index + 5 });
    });
function node(name, ...children) {
    return { name, children: children.flat().filter((v) => v !== undefined && v !== null) };
}
function child(n, name) {
    return n?.children?.find((c) => c && typeof c === 'object' && c.name === name);
}
function children(n, name) {
    return n?.children?.filter((c) => c && typeof c === 'object' && c.name === name) || [];
}
function value(n, name, fallback = '') {
    const c = name ? child(n, name) : n;
    return c?.children?.filter((v) => typeof v === 'string').join('') || fallback;
}
function encode(root) {
    const output = [Buffer.from([3, 1, 106, 0])];
    let currentPage = 0;
    const integer = (value) => {
        const bytes = [value & 127];
        while ((value >>>= 7)) bytes.unshift((value & 127) | 128);
        return Buffer.from(bytes);
    };
    function walk(n, depth = 0) {
        if (depth > 40) throw new Error('WBXML depth');
        if (Buffer.isBuffer(n)) {
            output.push(Buffer.from([0xc3]), integer(n.length), n);
            return;
        }
        if (typeof n === 'string' || typeof n === 'number') {
            const bytes = Buffer.from(String(n));
            if (bytes.includes(0)) throw new Error('NUL in WBXML text');
            output.push(Buffer.from([3]), bytes, Buffer.from([0]));
            return;
        }
        const token = byName.get(n.name);
        if (!token) throw new Error('Unknown WBXML tag: ' + n.name);
        if (token.page !== currentPage) {
            output.push(Buffer.from([0, token.page]));
            currentPage = token.page;
        }
        output.push(Buffer.from([token.token | (n.children.length ? 0x40 : 0)]));
        for (const c of n.children) walk(c, depth + 1);
        if (n.children.length) output.push(Buffer.from([1]));
    }
    walk(root);
    return Buffer.concat(output);
}
function decode(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > 32 * 1024 * 1024) throw new Error('WBXML size');
    let position = 0,
        page = 0,
        count = 0;
    const stack = [];
    let root;
    const read = () => {
        if (position >= bytes.length) throw new Error('Truncated WBXML');
        return bytes[position++];
    };
    const integer = () => {
        let n = 0;
        for (let i = 0; i < 5; i++) {
            const b = read();
            n = n * 128 + (b & 127);
            if (n > 0xffffffff) throw new Error('WBXML integer overflow');
            if (!(b & 128)) return n;
        }
        throw new Error('WBXML integer overflow');
    };
    if (read() !== 3 || integer() !== 1 || integer() !== 106 || integer() !== 0)
        throw new Error('Unsupported WBXML header');
    while (position < bytes.length) {
        const token = read();
        if (++count > 100000) throw new Error('WBXML node limit');
        if (token === 0) {
            page = read();
            if (!tables[page]) throw new Error('Unsupported WBXML code page');
            continue;
        }
        if (token === 1) {
            if (!stack.length) throw new Error('Unexpected WBXML end');
            stack.pop();
            continue;
        }
        if (token === 3 || token === 0xc3) {
            if (!stack.length) throw new Error('WBXML text outside root');
            if (token === 0xc3) {
                const length = integer();
                const end = position + length;
                if (end > bytes.length) throw new Error('Truncated WBXML opaque value');
                stack.at(-1).children.push(Buffer.from(bytes.subarray(position, end)));
                position = end;
                continue;
            }
            const end = bytes.indexOf(0, position);
            if (end < position) throw new Error('Truncated WBXML text');
            stack
                .at(-1)
                .children.push(
                    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(position, end))
                );
            position = end + 1;
            continue;
        }
        if (token & 0x80) throw new Error('WBXML attributes unsupported');
        const name = tables[page]?.[1].split(' ')[(token & 63) - 5];
        if (!name || name === '-') throw new Error('Unknown WBXML token');
        const item = node(tables[page][0] + ':' + name);
        if (stack.length) stack.at(-1).children.push(item);
        else if (root) throw new Error('Multiple WBXML roots');
        else root = item;
        if (token & 0x40) {
            stack.push(item);
            if (stack.length > 40) throw new Error('WBXML depth');
        }
    }
    if (!root || stack.length) throw new Error('Incomplete WBXML');
    return root;
}
module.exports = { node, child, children, value, encode, decode, tables };
