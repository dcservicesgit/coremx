'use strict';
const { value } = require('./wbxml');
const sets = {
    'Calendar:Attendees': ['Calendar:Attendee'],
    'Calendar:Attendee': [
        'Calendar:Email',
        'Calendar:Name',
        'Calendar:AttendeeStatus',
        'Calendar:AttendeeType',
        'MeetingResponse:ProposedStartTime',
        'MeetingResponse:ProposedEndTime'
    ],
    'Calendar:Exceptions': ['Calendar:Exception'],
    'Calendar:Exception':
        'Calendar:Deleted Calendar:ExceptionStartTime AirSyncBase:InstanceId Calendar:Subject Calendar:StartTime Calendar:EndTime Calendar:AllDayEvent Calendar:BusyStatus Calendar:Location AirSyncBase:Location Calendar:Reminder Calendar:Sensitivity Calendar:MeetingStatus Calendar:Attendees Calendar:Categories AirSyncBase:Body Calendar:ResponseType Calendar:AppointmentReplyTime Calendar:OnlineMeetingConfLink Calendar:OnlineMeetingExternalLink'.split(
            ' '
        ),
    'AirSyncBase:Body': [
        'AirSyncBase:Type',
        'AirSyncBase:Data',
        'AirSyncBase:EstimatedDataSize',
        'AirSyncBase:Truncated'
    ],
    'AirSyncBase:Location':
        'DisplayName Annotation Street City State Country PostalCode Latitude Longitude Accuracy Altitude AltitudeAccuracy LocationUri'
            .split(' ')
            .map((k) => 'AirSyncBase:' + k),
    'AirSyncBase:Attachments': ['AirSyncBase:Add', 'AirSyncBase:Delete'],
    'AirSyncBase:Add': 'ClientId Method Content DisplayName ContentType ContentId ContentLocation IsInline'
        .split(' ')
        .map((k) => 'AirSyncBase:' + k),
    'AirSyncBase:Delete': ['AirSyncBase:FileReference'],
    'Contacts:Children': ['Contacts:Child']
};
for (const ns of ['Calendar', 'Tasks'])
    sets[ns + ':Recurrence'] =
        'Type Until Occurrences Interval DayOfWeek DayOfMonth WeekOfMonth MonthOfYear CalendarType IsLeapMonth FirstDayOfWeek'
            .split(' ')
            .concat(ns === 'Tasks' ? ['Start', 'Regenerate', 'DeadOccur'] : [])
            .map((k) => ns + ':' + k);
for (const ns of ['Calendar', 'Contacts', 'Tasks', 'Notes', 'Email'])
    sets[ns + ':Categories'] = [ns + ':Category'];
exports.validate = function walk(element) {
    const allowed = sets[element.name];
    if (allowed) {
        if (element.children.some((c) => typeof c === 'string' || !allowed.includes(c.name)))
            throw new Error('Invalid nested class property');
        for (const c of element.children) walk(c);
    } else if (element.name === 'AirSyncBase:Content') {
        if (
            element.children.length !== 1 ||
            (!Buffer.isBuffer(element.children[0]) && typeof element.children[0] !== 'string')
        )
            throw new Error('Invalid attachment content');
    } else if (element.children.some((c) => typeof c !== 'string'))
        throw new Error('Text class property required');
    const key = element.name.split(':')[1],
        text = value(element);
    if (['Latitude', 'Longitude', 'Accuracy', 'Altitude', 'AltitudeAccuracy'].includes(key) && text) {
        const number = Number(text);
        if (
            !Number.isFinite(number) ||
            (key === 'Latitude' && Math.abs(number) > 90) ||
            (key === 'Longitude' && Math.abs(number) > 180) ||
            (['Accuracy', 'AltitudeAccuracy'].includes(key) && number < 0)
        )
            throw new Error('Invalid location coordinate');
    }
    if (element.name === 'Calendar:MeetingStatus' && ![0, 1, 3, 5, 7].includes(Number(text)))
        throw new Error('Invalid meeting status');
    if (element.name === 'Calendar:AttendeeStatus' && ![0, 2, 3, 4, 5].includes(Number(text)))
        throw new Error('Invalid attendee status');
    if (element.name === 'Calendar:AttendeeType' && ![1, 2, 3].includes(Number(text)))
        throw new Error('Invalid attendee type');
    if (['Category', 'Child'].includes(key) && text.length > 255) throw new Error('Class value too long');
};
