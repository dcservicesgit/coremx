'use strict';
const { tables, node: n, child, value } = require('./wbxml');
const calendar = require('./calendar-codec');
const { date } = require('./timezone');
const { base64 } = require('./mime');
const calendarFields = new Set(
    'TimeZone AllDayEvent Attendees BusyStatus Categories DtStamp EndTime Exceptions Location MeetingStatus OrganizerEmail OrganizerName Recurrence Reminder Sensitivity Subject StartTime UID DisallowNewTimeProposal ResponseRequested AppointmentReplyTime ResponseType CalendarType IsLeapMonth FirstDayOfWeek OnlineMeetingConfLink OnlineMeetingExternalLink ClientUid'
        .split(' ')
        .map((key) => 'Calendar:' + key)
);
const contacts = new Set([
    ...tables[1][1]
        .split(' ')
        .filter((k) => !['-', 'Category', 'Child'].includes(k))
        .map((k) => 'Contacts:' + k),
    ...tables[12][1].split(' ').map((k) => 'Contacts2:' + k)
]);
const tasks = new Set(
    'Categories Complete DateCompleted DueDate UtcDueDate Importance Recurrence ReminderSet ReminderTime Sensitivity StartDate UtcStartDate Subject OrdinalDate SubOrdinalDate'
        .split(' ')
        .map((key) => 'Tasks:' + key)
);
const notes = new Set(['Notes:Subject', 'Notes:MessageClass', 'Notes:LastModifiedDate', 'Notes:Categories']);
function tree(root, depth = 0) {
    if (depth > 10 || !root?.name || !Array.isArray(root.children))
        throw new Error('Invalid class structure');
    if (
        root.name === 'AirSyncBase:Content' &&
        root.children.length === 1 &&
        Buffer.isBuffer(root.children[0])
    )
        return;
    if (root.children.some((c) => typeof c !== 'string' && (!c || typeof c.name !== 'string')))
        throw new Error('Invalid class value');
    const counts = new Map();
    for (const item of root.children) {
        if (typeof item === 'string') {
            if (item.length > 256 * 1024 || item.includes('\0')) throw new Error('Class text limit');
            continue;
        }
        counts.set(item.name, (counts.get(item.name) || 0) + 1);
        if (
            counts.get(item.name) > 1 &&
            !/:(Attendee|Exception|Category|Child|Attachment|Add|Delete)$/.test(item.name)
        )
            throw new Error('Repeated class field');
        tree(item, depth + 1);
    }
}
function validate(type, data, { previous, version = '14.1' } = {}) {
    const root = n('AirSync:ApplicationData', data);
    tree(root);
    for (const element of data) require('./class-schema').validate(element);
    const allowed = { Calendar: calendarFields, Contacts: contacts, Tasks: tasks, Notes: notes }[type];
    if (
        !allowed ||
        data.some(
            (c) =>
                !allowed.has(c.name) &&
                c.name !== 'AirSyncBase:Body' &&
                !(version !== '14.1' && type === 'Calendar' && c.name === 'AirSyncBase:Attachments') &&
                !(type === 'Calendar' && version !== '14.1' && c.name === 'AirSyncBase:Location')
        )
    )
        throw new Error('Invalid class field');
    if (
        Buffer.byteLength(JSON.stringify(data.filter((c) => c.name !== 'AirSyncBase:Attachments'))) >
        256 * 1024
    )
        throw new Error('Class size limit');
    const body = child(root, 'AirSyncBase:Body');
    if (body) {
        if (!['1', '2', '3'].includes(value(body, 'AirSyncBase:Type')))
            throw new Error('Invalid body format');
        if (
            body.children.some(
                (c) =>
                    ![
                        'AirSyncBase:Type',
                        'AirSyncBase:Data',
                        'AirSyncBase:EstimatedDataSize',
                        'AirSyncBase:Truncated'
                    ].includes(c.name)
            )
        )
            throw new Error('Invalid body property');
    }
    for (const c of data) {
        const key = c.name.split(':')[1];
        const text = c.children.filter((x) => typeof x === 'string').join('');
        if (
            /^(AllDayEvent|Complete|ReminderSet|ResponseRequested|DisallowNewTimeProposal|IsLeapMonth)$/.test(
                key
            ) &&
            !/^[01]$/.test(text)
        )
            throw new Error('Invalid boolean');
        if (
            /(?:Date|Time)$/.test(key) &&
            !['TimeZone'].includes(key) &&
            text &&
            !['Contacts:Anniversary', 'Contacts:Birthday'].includes(c.name)
        )
            date(text);
        if (['Contacts:Anniversary', 'Contacts:Birthday'].includes(c.name) && text) date(text);
        if (c.name === 'Contacts:Picture' && text) base64(text, 1024 * 1024);
        if (/Email\dAddress$/.test(key) && text && (text.length > 320 || /[\r\n\0]/.test(text)))
            throw new Error('Invalid contact email');
        if (
            ['Importance', 'Sensitivity'].includes(key) &&
            (!/^\d$/.test(text) || +text > (key === 'Importance' ? 2 : 3))
        )
            throw new Error('Invalid class enum');
    }
    if (type === 'Calendar') return { calendar: calendar.fromEas(data, previous, version) };
    if (type === 'Tasks') {
        const start = value(root, 'Tasks:UtcStartDate', value(root, 'Tasks:StartDate'));
        const end = value(root, 'Tasks:UtcDueDate', value(root, 'Tasks:DueDate'));
        if (start && end && date(end) < date(start)) throw new Error('Task due date precedes start');
        const recurrence = child(root, 'Tasks:Recurrence');
        if (recurrence)
            calendar.recurrence(
                n(
                    'Calendar:Recurrence',
                    recurrence.children
                        .filter(
                            (c) => !['Tasks:Start', 'Tasks:Regenerate', 'Tasks:DeadOccur'].includes(c.name)
                        )
                        .map((c) => ({ ...c, name: c.name.replace('Tasks:', 'Calendar:') }))
                )
            );
        if (value(root, 'Tasks:ReminderSet') === '1' && !child(root, 'Tasks:ReminderTime'))
            throw new Error('Task reminder time required');
    }
    return {};
}
module.exports = { validate, tree };
