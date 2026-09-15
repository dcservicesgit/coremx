'use strict';
const crypto = require('node:crypto');
const { node: n, child, children, value } = require('./wbxml');
const tz = require('./timezone');
const { ICAL } = tz;
const days = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const f = (key, text) => n('Calendar:' + key, String(text));
const integer = (root, key, fallback, min, max) => {
    const text = value(root, 'Calendar:' + key, String(fallback));
    if (!/^\d+$/.test(text) || +text < min || +text > max) throw new Error('Invalid Calendar:' + key);
    return +text;
};
function recurrence(root) {
    if (!root) return null;
    const type = integer(root, 'Type', 0, 0, 6);
    if (![0, 1, 2, 3, 5, 6].includes(type)) throw new Error('Invalid recurrence type');
    for (const [key, types] of [
        ['DayOfWeek', [0, 1, 3, 6]],
        ['DayOfMonth', [2, 5]],
        ['WeekOfMonth', [3, 6]],
        ['MonthOfYear', [5, 6]]
    ])
        if (child(root, 'Calendar:' + key) && !types.includes(type))
            throw new Error('Recurrence field does not match type');
    const interval = integer(root, 'Interval', 1, 1, 999);
    const rule = [
        `FREQ=${{ 0: 'DAILY', 1: 'WEEKLY', 2: 'MONTHLY', 3: 'MONTHLY', 5: 'YEARLY', 6: 'YEARLY' }[type]}`,
        `INTERVAL=${interval}`
    ];
    if (child(root, 'Calendar:Occurrences') && child(root, 'Calendar:Until'))
        throw new Error('Recurrence cannot contain count and until');
    if (child(root, 'Calendar:Occurrences')) rule.push('COUNT=' + integer(root, 'Occurrences', 1, 1, 10000));
    if (child(root, 'Calendar:Until')) rule.push('UNTIL=' + tz.compact(value(root, 'Calendar:Until')));
    if (child(root, 'Calendar:DayOfWeek') || [1, 3, 6].includes(type)) {
        const mask = integer(root, 'DayOfWeek', 0, 1, 127);
        rule.push('BYDAY=' + days.filter((_, index) => mask & (1 << index)).join(','));
    }
    if ([2, 5].includes(type)) rule.push('BYMONTHDAY=' + integer(root, 'DayOfMonth', 0, 1, 31));
    if ([3, 6].includes(type)) {
        const week = integer(root, 'WeekOfMonth', 0, 1, 5);
        rule.push('BYSETPOS=' + (week === 5 ? -1 : week));
    }
    if ([5, 6].includes(type)) rule.push('BYMONTH=' + integer(root, 'MonthOfYear', 0, 1, 12));
    if (child(root, 'Calendar:FirstDayOfWeek'))
        rule.push('WKST=' + days[integer(root, 'FirstDayOfWeek', 0, 0, 6)]);
    // Gregorian is the recurrence arithmetic used by ActiveSync's standard patterns.
    if (
        child(root, 'Calendar:CalendarType') &&
        ![0, 1, 2, 9, 10, 11, 12].includes(integer(root, 'CalendarType', 0, 0, 23))
    )
        throw new Error('Non-Gregorian recurrence is not representable');
    if (value(root, 'Calendar:IsLeapMonth', '0') !== '0')
        throw new Error('Leap-month recurrence is not representable');
    return rule.join(';');
}
function recurrenceData(rule) {
    if (!rule) return null;
    const r = ICAL.Recur.fromString(rule);
    const byday = r.getComponent('BYDAY');
    const monthday = r.getComponent('BYMONTHDAY');
    const type = { DAILY: 0, WEEKLY: 1, MONTHLY: monthday.length ? 2 : 3, YEARLY: monthday.length ? 5 : 6 }[
        r.freq
    ];
    if (
        ([0, 1].includes(type) &&
            (monthday.length || r.getComponent('BYSETPOS').length || r.getComponent('BYMONTH').length)) ||
        ([2, 5].includes(type) && byday.length) ||
        type === undefined ||
        monthday.length > 1 ||
        monthday.some((d) => d < 1) ||
        r.getComponent('BYMONTH').length > 1 ||
        r.getComponent('BYSETPOS').length > 1
    )
        throw new Error('Recurrence cannot be represented by ActiveSync');
    const setpos = r.getComponent('BYSETPOS')[0] || Number(String(byday[0] || '').match(/^-?\d+/)?.[0] || 0);
    if (
        ([3, 6].includes(type) && (!byday.length || ![1, 2, 3, 4, -1].includes(setpos))) ||
        ([5, 6].includes(type) && !r.getComponent('BYMONTH').length) ||
        (byday.some((day) => /^-?\d/.test(day)) && byday.length > 1)
    )
        throw new Error('Recurrence cannot be represented by ActiveSync');
    return n(
        'Calendar:Recurrence',
        f('Type', type),
        f('Interval', r.interval),
        r.count ? f('Occurrences', r.count) : null,
        r.until ? f('Until', tz.compact(r.until.toJSDate())) : null,
        byday.length
            ? f(
                  'DayOfWeek',
                  byday.reduce((mask, day) => mask | (1 << days.indexOf(day.slice(-2))), 0)
              )
            : null,
        monthday.length ? f('DayOfMonth', monthday[0]) : null,
        setpos ? f('WeekOfMonth', setpos === -1 ? 5 : setpos) : null,
        r.getComponent('BYMONTH').length ? f('MonthOfYear', r.getComponent('BYMONTH')[0]) : null,
        f('FirstDayOfWeek', (r.wkst || 2) - 1)
    );
}
function validate(event) {
    if (!event || typeof event.uid !== 'string' || !event.uid || event.uid.length > 255)
        throw new Error('Calendar UID required');
    const start = tz.date(event.start);
    const end = tz.date(event.end);
    if (end <= start || end - start > 366 * 86400000) throw new Error('Calendar end must follow start');
    if (event.timezone) tz.decodeZone(event.timezone);
    else tz.offsetAt(start.getTime(), event.timeZone || 'UTC');
    if (event.allDay) {
        const localStart = tz.wallTime(start.getTime(), event.timeZone, event.timezone);
        const localEnd = tz.wallTime(end.getTime(), event.timeZone, event.timezone);
        if (!localStart.endsWith('T00:00:00') || !localEnd.endsWith('T00:00:00'))
            throw new Error('All-day events require local midnight boundaries');
    }
    if (
        typeof event.subject !== 'string' ||
        event.subject.length > 4096 ||
        String(event.body || '').length > 256 * 1024 ||
        String(event.location || '').length > 4096
    )
        throw new Error('Calendar field size');
    if (!Number.isInteger(event.sequence) || event.sequence < 0 || event.sequence > 0x7fffffff)
        throw new Error('Invalid calendar sequence');
    if ((event.attendees || []).length > 100 || (event.exceptions || []).length > 1000)
        throw new Error('Calendar collection size');
    const address = require('./mail').address;
    if (event.organizer?.email) event.organizer.email = address(event.organizer.email);
    if (event.allDay !== undefined && typeof event.allDay !== 'boolean')
        throw new Error('Invalid all-day value');
    for (const [key, max] of [
        ['busy', 4],
        ['sensitivity', 3],
        ['responseType', 5],
        ['reminder', 525600]
    ]) {
        if (event[key] !== undefined && (!Number.isInteger(event[key]) || event[key] < 0 || event[key] > max))
            throw new Error('Invalid calendar ' + key);
    }
    if (event.status && !['CONFIRMED', 'TENTATIVE', 'CANCELLED'].includes(event.status))
        throw new Error('Invalid calendar status');
    if (
        event.categories &&
        (!Array.isArray(event.categories) ||
            event.categories.length > 100 ||
            event.categories.some((c) => typeof c !== 'string' || c.length > 255))
    )
        throw new Error('Invalid calendar categories');
    if (event.locationDetails)
        require('./class-schema').validate(n('AirSyncBase:Location', event.locationDetails));
    const seen = new Set();
    for (const attendee of event.attendees || []) {
        const email = address(attendee.email);
        attendee.email = email;
        if (seen.has(email)) throw new Error('Duplicate attendee');
        seen.add(email);
        if (
            !['NEEDS-ACTION', 'ACCEPTED', 'DECLINED', 'TENTATIVE', 'DELEGATED'].includes(
                attendee.status || 'NEEDS-ACTION'
            )
        )
            throw new Error('Invalid attendee response');
    }
    if (event.rrule) {
        if (event.rrule.length > 2048) throw new Error('Recurrence size');
        const components = event.rrule
            .toUpperCase()
            .split(';')
            .map((p) => p.split('='));
        if (
            new Set(components.map(([key]) => key)).size !== components.length ||
            components.some(
                ([key, val]) =>
                    !val ||
                    ![
                        'FREQ',
                        'INTERVAL',
                        'COUNT',
                        'UNTIL',
                        'BYDAY',
                        'BYMONTH',
                        'BYMONTHDAY',
                        'BYSETPOS',
                        'WKST'
                    ].includes(key)
            ) ||
            components.some(
                ([key, val]) => ['COUNT', 'INTERVAL'].includes(key) && (!/^\d+$/.test(val) || +val < 1)
            )
        )
            throw new Error('Invalid recurrence syntax');
        const initial = ICAL.Recur.fromString(event.rrule);
        const wall = new Date(tz.wallTime(start.getTime(), event.timeZone, event.timezone) + 'Z');
        if (initial.freq === 'WEEKLY' && !initial.getComponent('BYDAY').length)
            event.rrule += ';BYDAY=' + days[wall.getUTCDay()];
        if (
            ['MONTHLY', 'YEARLY'].includes(initial.freq) &&
            !initial.getComponent('BYDAY').length &&
            !initial.getComponent('BYMONTHDAY').length
        )
            event.rrule += ';BYMONTHDAY=' + wall.getUTCDate();
        if (initial.freq === 'YEARLY' && !initial.getComponent('BYMONTH').length)
            event.rrule += ';BYMONTH=' + (wall.getUTCMonth() + 1);
        const rule = ICAL.Recur.fromString(event.rrule);
        if (
            !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq) ||
            rule.interval < 1 ||
            rule.interval > 999 ||
            rule.count < 0 ||
            rule.count > 10000 ||
            (rule.count && rule.until)
        )
            throw new Error('Invalid recurrence');
        if (rule.until && rule.until.toJSDate() < start) throw new Error('Recurrence ends before start');
        for (const [part, min, max] of [
            ['BYMONTH', 1, 12],
            ['BYMONTHDAY', -31, 31],
            ['BYSETPOS', -366, 366]
        ])
            if (rule.getComponent(part).some((v) => !Number.isInteger(v) || v === 0 || v < min || v > max))
                throw new Error('Invalid recurrence component');
        if (rule.getComponent('BYDAY').some((day) => !/^(?:-?[1-5])?(SU|MO|TU|WE|TH|FR|SA)$/.test(day)))
            throw new Error('Invalid recurrence weekday');
        recurrenceData(event.rrule);
    }
    const instances = new Set();
    for (const exception of event.exceptions || []) {
        tz.date(exception.instance);
        if (instances.has(exception.instance)) throw new Error('Duplicate recurrence exception');
        instances.add(exception.instance);
        if (!event.rrule) throw new Error('Exception requires recurrence');
        if (!hasInstance({ ...event, exceptions: [] }, exception.instance))
            throw new Error('Exception is not an occurrence');
        if (!exception.deleted && exception.start)
            validate({
                ...event,
                ...exception,
                end:
                    exception.end ||
                    new Date(
                        Date.parse(exception.start) + Date.parse(event.end) - Date.parse(event.start)
                    ).toISOString(),
                rrule: null,
                exceptions: []
            });
    }
    return event;
}
function fromEas(data, previous, version = '14.1') {
    const root = n('AirSync:ApplicationData', data);
    const now = new Date().toISOString();
    const event = {
        ...previous,
        uid: value(
            root,
            'Calendar:UID',
            value(root, 'Calendar:ClientUid', previous?.uid || crypto.randomUUID())
        ),
        subject: value(root, 'Calendar:Subject', previous?.subject || ''),
        start: tz.date(value(root, 'Calendar:StartTime', previous?.start)).toISOString(),
        end: tz.date(value(root, 'Calendar:EndTime', previous?.end)).toISOString(),
        timezone: value(root, 'Calendar:TimeZone', previous?.timezone || ''),
        timeZone: previous?.timeZone || 'UTC',
        allDay: integer(root, 'AllDayEvent', previous?.allDay ? 1 : 0, 0, 1) === 1,
        busy: integer(root, 'BusyStatus', previous?.busy ?? 2, 0, 4),
        sensitivity: integer(root, 'Sensitivity', previous?.sensitivity ?? 0, 0, 3),
        meetingStatus: integer(root, 'MeetingStatus', previous?.meetingStatus ?? 0, 0, 7),
        sequence: previous?.sequence ?? 0,
        ics: undefined,
        dtstamp: child(root, 'Calendar:DtStamp')
            ? tz.date(value(root, 'Calendar:DtStamp')).toISOString()
            : now,
        organizer: {
            email: value(root, 'Calendar:OrganizerEmail', previous?.organizer?.email || ''),
            name: value(root, 'Calendar:OrganizerName', previous?.organizer?.name || '')
        },
        body: value(child(root, 'AirSyncBase:Body'), 'AirSyncBase:Data', previous?.body || ''),
        location: value(
            root,
            'Calendar:Location',
            value(child(root, 'AirSyncBase:Location'), 'AirSyncBase:DisplayName', previous?.location || '')
        ),
        rrule: child(root, 'Calendar:Recurrence')
            ? recurrence(child(root, 'Calendar:Recurrence'))
            : previous?.rrule || null,
        reminder: child(root, 'Calendar:Reminder')
            ? integer(root, 'Reminder', 0, 0, 525600)
            : previous?.reminder,
        responseRequested:
            value(root, 'Calendar:ResponseRequested', previous?.responseRequested === false ? '0' : '1') !==
            '0'
    };
    if (child(root, 'Calendar:Attendees'))
        event.attendees = children(child(root, 'Calendar:Attendees'), 'Calendar:Attendee').map((a) => ({
            email: value(a, 'Calendar:Email'),
            name: value(a, 'Calendar:Name'),
            role: integer(a, 'AttendeeType', 1, 1, 3),
            status:
                { 0: 'NEEDS-ACTION', 2: 'TENTATIVE', 3: 'ACCEPTED', 4: 'DECLINED', 5: 'NEEDS-ACTION' }[
                    integer(a, 'AttendeeStatus', 0, 0, 5)
                ] || 'NEEDS-ACTION'
        }));
    event.attendees ||= [];
    for (const [key, tag] of [
        ['onlineMeetingConfLink', 'OnlineMeetingConfLink'],
        ['onlineMeetingExternalLink', 'OnlineMeetingExternalLink']
    ]) {
        if (child(root, 'Calendar:' + tag)) event[key] = value(root, 'Calendar:' + tag);
    }
    if (child(root, 'Calendar:AppointmentReplyTime'))
        event.appointmentReplyTime = tz.date(value(root, 'Calendar:AppointmentReplyTime')).toISOString();
    if (child(root, 'Calendar:ResponseType')) event.responseType = integer(root, 'ResponseType', 0, 0, 5);
    if (child(root, 'AirSyncBase:Location'))
        event.locationDetails = child(root, 'AirSyncBase:Location').children.filter(
            (c) => c.name !== 'AirSyncBase:DisplayName'
        );
    if (child(root, 'Calendar:Categories'))
        event.categories = children(child(root, 'Calendar:Categories'), 'Calendar:Category').map((c) =>
            value(c)
        );
    event.disallowNewTimeProposal =
        value(root, 'Calendar:DisallowNewTimeProposal', previous?.disallowNewTimeProposal ? '1' : '0') ===
        '1';
    if (child(root, 'Calendar:Exceptions'))
        event.exceptions = children(child(root, 'Calendar:Exceptions'), 'Calendar:Exception').map((e) => {
            const instance = tz
                .date(value(e, version === '14.1' ? 'Calendar:ExceptionStartTime' : 'AirSyncBase:InstanceId'))
                .toISOString();
            const deleted = value(e, 'Calendar:Deleted') === '1';
            const override = { instance, deleted };
            if (!deleted) {
                for (const [property, key] of [
                    ['start', 'StartTime'],
                    ['end', 'EndTime']
                ])
                    if (child(e, 'Calendar:' + key))
                        override[property] = tz.date(value(e, 'Calendar:' + key)).toISOString();
                if (child(e, 'Calendar:Subject')) override.subject = value(e, 'Calendar:Subject');
                if (child(e, 'Calendar:Location')) override.location = value(e, 'Calendar:Location');
                if (child(e, 'AirSyncBase:Location')) {
                    override.location = value(child(e, 'AirSyncBase:Location'), 'AirSyncBase:DisplayName');
                    override.locationDetails = child(e, 'AirSyncBase:Location').children.filter(
                        (c) => c.name !== 'AirSyncBase:DisplayName'
                    );
                }
                if (child(e, 'AirSyncBase:Body'))
                    override.body = value(child(e, 'AirSyncBase:Body'), 'AirSyncBase:Data');
                for (const [property, key, max] of [
                    ['allDay', 'AllDayEvent', 1],
                    ['busy', 'BusyStatus', 4],
                    ['sensitivity', 'Sensitivity', 3],
                    ['reminder', 'Reminder', 525600]
                ])
                    if (child(e, 'Calendar:' + key))
                        override[property] =
                            property === 'allDay'
                                ? integer(e, key, 0, 0, max) === 1
                                : integer(e, key, 0, 0, max);
                if (child(e, 'Calendar:Attendees'))
                    override.attendees = children(child(e, 'Calendar:Attendees'), 'Calendar:Attendee').map(
                        (a) => ({
                            email: value(a, 'Calendar:Email'),
                            name: value(a, 'Calendar:Name'),
                            role: integer(a, 'AttendeeType', 1, 1, 3),
                            status:
                                { 3: 'ACCEPTED', 2: 'TENTATIVE', 4: 'DECLINED' }[
                                    integer(a, 'AttendeeStatus', 0, 0, 5)
                                ] || 'NEEDS-ACTION'
                        })
                    );
            }
            return override;
        });
    event.exceptions ||= [];
    return validate(event);
}
function toEas(event, version = '14.1') {
    const newer = version !== '14.1';
    return [
        f('TimeZone', event.timezone || tz.encodeZone(event.timeZone || 'UTC', Date.parse(event.start))),
        f('AllDayEvent', event.allDay ? 1 : 0),
        f('Subject', event.subject),
        f('StartTime', tz.compact(event.start)),
        f('EndTime', tz.compact(event.end)),
        f('DtStamp', tz.compact(event.dtstamp || new Date())),
        f('UID', event.uid),
        f('BusyStatus', event.busy ?? 2),
        f('Sensitivity', event.sensitivity || 0),
        f(
            'MeetingStatus',
            event.status === 'CANCELLED' ? 5 : event.meetingStatus || (event.attendees?.length ? 1 : 0)
        ),
        event.organizer?.email ? f('OrganizerEmail', event.organizer.email) : null,
        event.organizer?.name ? f('OrganizerName', event.organizer.name) : null,
        event.categories?.length
            ? n(
                  'Calendar:Categories',
                  event.categories.map((c) => f('Category', c))
              )
            : null,
        f('DisallowNewTimeProposal', event.disallowNewTimeProposal ? 1 : 0),
        f('ResponseRequested', event.responseRequested === false ? 0 : 1),
        event.responseType !== undefined ? f('ResponseType', event.responseType) : null,
        event.appointmentReplyTime ? f('AppointmentReplyTime', tz.compact(event.appointmentReplyTime)) : null,
        event.onlineMeetingConfLink ? f('OnlineMeetingConfLink', event.onlineMeetingConfLink) : null,
        event.onlineMeetingExternalLink
            ? f('OnlineMeetingExternalLink', event.onlineMeetingExternalLink)
            : null,
        event.reminder !== undefined ? f('Reminder', event.reminder) : null,
        newer
            ? n(
                  'AirSyncBase:Location',
                  n('AirSyncBase:DisplayName', event.location || ''),
                  event.locationDetails || []
              )
            : f('Location', event.location || ''),
        n(
            'AirSyncBase:Body',
            n('AirSyncBase:Type', '1'),
            n('AirSyncBase:EstimatedDataSize', String(Buffer.byteLength(event.body || ''))),
            n('AirSyncBase:Data', event.body || '')
        ),
        recurrenceData(event.rrule),
        event.attendees?.length
            ? n(
                  'Calendar:Attendees',
                  event.attendees.map((a) =>
                      n(
                          'Calendar:Attendee',
                          f('Email', a.email),
                          f('Name', a.name || a.email),
                          f('AttendeeType', a.role || 1),
                          f('AttendeeStatus', { ACCEPTED: 3, TENTATIVE: 2, DECLINED: 4 }[a.status] || 0),
                          version === '16.1' && event.proposals?.[a.email]
                              ? n(
                                    'MeetingResponse:ProposedStartTime',
                                    tz.compact(event.proposals[a.email].start)
                                )
                              : null,
                          version === '16.1' && event.proposals?.[a.email]
                              ? n('MeetingResponse:ProposedEndTime', tz.compact(event.proposals[a.email].end))
                              : null
                      )
                  )
              )
            : null,
        event.exceptions?.length
            ? n(
                  'Calendar:Exceptions',
                  event.exceptions.map((e) =>
                      n(
                          'Calendar:Exception',
                          newer
                              ? n('AirSyncBase:InstanceId', tz.compact(e.instance))
                              : f('ExceptionStartTime', tz.compact(e.instance)),
                          f('Deleted', e.deleted ? 1 : 0),
                          e.start ? f('StartTime', tz.compact(e.start)) : null,
                          e.end ? f('EndTime', tz.compact(e.end)) : null,
                          e.subject !== undefined ? f('Subject', e.subject) : null,
                          e.location !== undefined
                              ? newer
                                  ? n(
                                        'AirSyncBase:Location',
                                        n('AirSyncBase:DisplayName', e.location),
                                        e.locationDetails || []
                                    )
                                  : f('Location', e.location)
                              : null,
                          e.allDay !== undefined ? f('AllDayEvent', e.allDay ? 1 : 0) : null,
                          e.busy !== undefined ? f('BusyStatus', e.busy) : null,
                          e.reminder !== undefined ? f('Reminder', e.reminder) : null,
                          e.body !== undefined
                              ? n(
                                    'AirSyncBase:Body',
                                    n('AirSyncBase:Type', '1'),
                                    n('AirSyncBase:Data', e.body)
                                )
                              : null,
                          e.attendees
                              ? n(
                                    'Calendar:Attendees',
                                    e.attendees.map((a) =>
                                        n(
                                            'Calendar:Attendee',
                                            f('Email', a.email),
                                            f('Name', a.name || a.email),
                                            f('AttendeeType', a.role || 1),
                                            f(
                                                'AttendeeStatus',
                                                { ACCEPTED: 3, TENTATIVE: 2, DECLINED: 4 }[a.status] || 0
                                            )
                                        )
                                    )
                                )
                              : null
                      )
                  )
              )
            : null
    ].filter(Boolean);
}
function toICS(event, method = 'REQUEST', attendeeOnly, instanceId) {
    validate(event);
    const calendar = new ICAL.Component('vcalendar');
    calendar.addPropertyWithValue('version', '2.0');
    calendar.addPropertyWithValue('prodid', '-//CoreMX//Calendar//EN');
    calendar.addPropertyWithValue('method', method);
    const zone = tz.zoneComponent(
        event.timezone || tz.encodeZone(event.timeZone || 'UTC', Date.parse(event.start))
    );
    calendar.addSubcomponent(zone);
    const zoneId = zone.getFirstPropertyValue('tzid');
    function addTime(component, name, time, allDay = false) {
        const local = tz.wallTime(Date.parse(time), event.timeZone, event.timezone);
        const property = new ICAL.Property(name);
        property.setValue(ICAL.Time.fromString(allDay ? local.slice(0, 10) : local));
        if (!allDay) property.setParameter('tzid', zoneId);
        component.addProperty(property);
    }
    function addEvent(data, instance) {
        const component = new ICAL.Component('vevent');
        for (const [key, val] of Object.entries({
            uid: event.uid,
            summary: data.subject || '',
            location: data.location || '',
            description: data.body || '',
            sequence: data.sequence || 0,
            status:
                (data.deleted && !['REPLY', 'COUNTER'].includes(method)) || method === 'CANCEL'
                    ? 'CANCELLED'
                    : 'CONFIRMED',
            transp: data.busy === 0 ? 'TRANSPARENT' : 'OPAQUE'
        }))
            component.addPropertyWithValue(key, val);
        component.addPropertyWithValue(
            'dtstamp',
            ICAL.Time.fromJSDate(new Date(data.dtstamp || Date.now()), true)
        );
        addTime(component, 'dtstart', data.start, data.allDay);
        addTime(component, 'dtend', data.end, data.allDay);
        if (instance) addTime(component, 'recurrence-id', instance, data.allDay);
        else if (data.rrule) component.addPropertyWithValue('rrule', ICAL.Recur.fromString(data.rrule));
        if (data.categories?.length) {
            const categories = new ICAL.Property('categories');
            categories.setValues(data.categories);
            component.addProperty(categories);
        }
        if (data.organizer?.email) {
            const organizer = new ICAL.Property('organizer');
            organizer.setValue('mailto:' + data.organizer.email);
            if (data.organizer.name) organizer.setParameter('cn', data.organizer.name);
            component.addProperty(organizer);
        }
        for (const a of (data.attendees || []).filter((a) => !attendeeOnly || a.email === attendeeOnly)) {
            const attendee = new ICAL.Property('attendee');
            attendee.setValue('mailto:' + a.email);
            attendee.setParameter('cn', a.name || a.email);
            attendee.setParameter('partstat', a.status || 'NEEDS-ACTION');
            attendee.setParameter('role', a.role === 2 ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT');
            attendee.setParameter('rsvp', data.responseRequested === false ? 'FALSE' : 'TRUE');
            component.addProperty(attendee);
        }
        if (data.reminder !== undefined) {
            const alarm = new ICAL.Component('valarm');
            alarm.addPropertyWithValue('action', 'DISPLAY');
            alarm.addPropertyWithValue('description', data.subject || 'Reminder');
            alarm.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-data.reminder * 60));
            component.addSubcomponent(alarm);
        }
        calendar.addSubcomponent(component);
    }
    if (instanceId) {
        const exception = event.exceptions?.find((e) => e.instance === instanceId) || {};
        const start = exception.start || (method === 'COUNTER' ? event.start : instanceId);
        const end =
            exception.end ||
            new Date(Date.parse(start) + Date.parse(event.end) - Date.parse(event.start)).toISOString();
        addEvent({ ...event, ...exception, start, end }, instanceId);
    } else addEvent(event);
    for (const exception of instanceId ? [] : event.exceptions || []) {
        const start = exception.start || exception.instance;
        const end =
            exception.end ||
            new Date(Date.parse(start) + Date.parse(event.end) - Date.parse(event.start)).toISOString();
        addEvent({ ...event, ...exception, start, end }, exception.instance);
    }
    return calendar.toString();
}
function parseICS(text) {
    if (Buffer.byteLength(text) > 1024 * 1024 || (text.match(/BEGIN:VEVENT/gi) || []).length > 1001)
        throw new Error('Calendar size limit');
    const component = new ICAL.Component(ICAL.parse(text));
    if (component.name !== 'vcalendar') throw new Error('VCALENDAR required');
    const method = String(component.getFirstPropertyValue('method') || 'PUBLISH').toUpperCase();
    if (
        !['REQUEST', 'REPLY', 'CANCEL', 'PUBLISH', 'COUNTER', 'DECLINECOUNTER', 'ADD', 'REFRESH'].includes(
            method
        )
    )
        throw new Error('Unsupported calendar method');
    const components = component.getAllSubcomponents('vevent');
    const master = components.find((c) => !c.hasProperty('recurrence-id')) || components[0];
    if (!master) throw new Error('VEVENT required');
    function read(c) {
        const propertyTime = (name) => {
            const p = c.getFirstProperty(name);
            if (!p) return null;
            const time = p.getFirstValue();
            if (time.zone?.tzid === 'floating' && p.getParameter('tzid'))
                return new Date(
                    tz.fromWall(time.toString().slice(0, 19), p.getParameter('tzid'))
                ).toISOString();
            return time.toJSDate().toISOString();
        };
        const start = propertyTime('dtstart');
        const end =
            propertyTime('dtend') ||
            (start
                ? new Date(
                      Date.parse(start) + (c.getFirstPropertyValue('duration')?.toSeconds() || 86400) * 1000
                  ).toISOString()
                : null);
        const org = c.getFirstProperty('organizer');
        const attendees = c.getAllProperties('attendee').map((p) => ({
            email: String(p.getFirstValue())
                .replace(/^mailto:/i, '')
                .toLowerCase(),
            name: p.getParameter('cn') || '',
            status: p.getParameter('partstat') || 'NEEDS-ACTION',
            role: p.getParameter('role') === 'OPT-PARTICIPANT' ? 2 : 1
        }));
        const timeZone = c.getFirstProperty('dtstart')?.getParameter('tzid') || 'UTC';
        let timezone = '';
        const storedZone = component
            .getAllSubcomponents('vtimezone')
            .find((zone) => zone.getFirstPropertyValue('tzid') === timeZone);
        if (storedZone) timezone = tz.fromComponent(storedZone);
        else timezone = tz.encodeZone(timeZone, start ? Date.parse(start) : Date.now());
        return {
            uid: String(c.getFirstPropertyValue('uid') || ''),
            subject: c.getFirstPropertyValue('summary') || '',
            start,
            end,
            allDay: !!c.getFirstPropertyValue('dtstart')?.isDate,
            timeZone: timezone ? 'UTC' : timeZone,
            timezone,
            body: c.getFirstPropertyValue('description') || '',
            categories: c.getFirstProperty('categories')?.getValues() || [],
            location: c.getFirstPropertyValue('location') || '',
            sequence: c.getFirstPropertyValue('sequence') || 0,
            dtstamp: propertyTime('dtstamp') || new Date().toISOString(),
            organizer: {
                email: String(org?.getFirstValue() || '')
                    .replace(/^mailto:/i, '')
                    .toLowerCase(),
                name: org?.getParameter('cn') || ''
            },
            attendees,
            rrule: c.getFirstPropertyValue('rrule')?.toString() || null,
            status: c.getFirstPropertyValue('status') || 'CONFIRMED',
            busy: c.getFirstPropertyValue('transp') === 'TRANSPARENT' ? 0 : 2,
            instance: propertyTime('recurrence-id'),
            exceptions: []
        };
    }
    const event = read(master);
    event.ics = component.toString();
    event.exceptions = components
        .filter((c) => c !== master)
        .map((c) => {
            const e = read(c);
            if (e.uid !== event.uid) throw new Error('Multiple unrelated events');
            return { ...e, instance: e.instance, deleted: e.status === 'CANCELLED' };
        });
    if (!['REPLY', 'CANCEL', 'REFRESH', 'DECLINECOUNTER'].includes(method)) validate(event);
    return { method, event };
}
function hasInstance(event, instance) {
    const time = tz.date(instance).getTime();
    const base = { ...event, status: 'CONFIRMED', exceptions: [], ics: undefined };
    return occurrences(base, new Date(time - 1).toISOString(), new Date(time + 86400000).toISOString()).some(
        (row) => row.instance === new Date(time).toISOString()
    );
}
function occurrences(event, from, to, limit = 1000) {
    const lower = Date.parse(from),
        upper = Date.parse(to);
    if (
        !Number.isFinite(lower) ||
        !Number.isFinite(upper) ||
        upper <= lower ||
        upper - lower > 366 * 86400000 * 5
    )
        throw new Error('Invalid calendar query window');
    if (event.status === 'CANCELLED') return [];
    const calendar = new ICAL.Component(ICAL.parse(event.ics || toICS(event, 'PUBLISH')));
    const component = calendar.getAllSubcomponents('vevent').find((c) => !c.hasProperty('recurrence-id'));
    if (!component) return [];
    const master = new ICAL.Event(component, {
        exceptions: calendar.getAllSubcomponents('vevent').filter((c) => c !== component)
    });
    const iterator = master.iterator();
    const result = [];
    let count = 0,
        occurrence;
    while ((occurrence = iterator.next())) {
        if (++count > 100000) throw new Error('Recurrence expansion limit');
        const detail = master.getOccurrenceDetails(occurrence);
        const start = detail.startDate.toJSDate().getTime();
        const end = detail.endDate.toJSDate().getTime();
        if (occurrence.toJSDate().getTime() >= upper) break;
        if (
            start < upper &&
            end > lower &&
            detail.item.component.getFirstPropertyValue('status') !== 'CANCELLED'
        ) {
            result.push({
                ...event,
                instance: occurrence.toJSDate().toISOString(),
                start: new Date(start).toISOString(),
                end: new Date(end).toISOString(),
                subject: detail.item.summary || event.subject
            });
            if (result.length >= limit) break;
        }
    }
    // A moved exception can lie inside the window even when its original slot is outside it.
    for (const exception of event.exceptions || []) {
        if (
            exception.deleted ||
            !exception.start ||
            result.some((row) => row.instance === exception.instance)
        )
            continue;
        const start = Date.parse(exception.start),
            end = Date.parse(
                exception.end ||
                    new Date(start + Date.parse(event.end) - Date.parse(event.start)).toISOString()
            );
        if (start < upper && end > lower && result.length < limit)
            result.push({
                ...event,
                ...exception,
                start: new Date(start).toISOString(),
                end: new Date(end).toISOString()
            });
    }
    return result.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}
function occursAfter(event, cutoff) {
    if (event.status === 'CANCELLED') return false;
    if (!event.rrule) return Date.parse(event.end) >= cutoff;
    const component = new ICAL.Component(ICAL.parse(event.ics || toICS(event, 'PUBLISH')));
    const masterComponent = component
        .getAllSubcomponents('vevent')
        .find((c) => !c.hasProperty('recurrence-id'));
    if (!masterComponent) return false;
    const master = new ICAL.Event(masterComponent, {
        exceptions: component.getAllSubcomponents('vevent').filter((c) => c !== masterComponent)
    });
    const iterator = master.iterator();
    let occurrence,
        count = 0;
    while ((occurrence = iterator.next())) {
        if (++count > 100000) throw new Error('Recurrence expansion limit');
        const details = master.getOccurrenceDetails(occurrence);
        if (
            details.endDate.toJSDate().getTime() >= cutoff &&
            details.item.component.getFirstPropertyValue('status') !== 'CANCELLED'
        )
            return true;
    }
    return false;
}
module.exports = {
    occursAfter,
    hasInstance,
    validate,
    fromEas,
    toEas,
    toICS,
    parseICS,
    occurrences,
    recurrence,
    recurrenceData
};
