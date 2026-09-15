'use strict';
const { node: n, child, children, value } = require('./wbxml');
const { compact } = require('./timezone');
const f = (name, text) => n(name, String(text));
module.exports = async function meetingResponse(eas, root, auth) {
    const requests = children(root, 'MeetingResponse:Request');
    if (!requests.length || requests.length > 100) throw new Error('Invalid meeting responses');
    const results = [];
    for (const request of requests) {
        const longId = value(request, 'Search:LongId');
        const id = longId || value(request, 'MeetingResponse:RequestId');
        let status = 1,
            calendarId;
        try {
            const source = eas.store.forMailbox(auth.mailbox.id).get('messages', id);
            if (!source || (!longId && source.folder !== value(request, 'MeetingResponse:CollectionId')))
                throw new Error('Meeting unavailable');
            const send = child(request, 'MeetingResponse:SendResponse');
            const response = { 1: 'ACCEPTED', 2: 'TENTATIVE', 3: 'DECLINED' }[
                value(request, 'MeetingResponse:UserResponse')
            ];
            const result = await eas.mail.calendar.respond(auth, id, response, {
                instance: value(request, 'MeetingResponse:InstanceId') || undefined,
                sendResponse: !!send,
                body: value(child(send, 'AirSyncBase:Body'), 'AirSyncBase:Data'),
                proposedStart: value(send, 'MeetingResponse:ProposedStartTime') || undefined,
                proposedEnd: value(send, 'MeetingResponse:ProposedEndTime') || undefined
            });
            if (response !== 'DECLINED') calendarId = result.id;
        } catch {
            status = 2;
        }
        results.push(
            n(
                'MeetingResponse:Result',
                f('MeetingResponse:RequestId', id),
                f('MeetingResponse:Status', status),
                calendarId ? f('MeetingResponse:CalendarId', calendarId) : null
            )
        );
    }
    return n('MeetingResponse:MeetingResponse', results);
};
module.exports.metadata = (invitation, version = '14.1') => {
    const e = invitation.event;
    const data = Buffer.concat([
        Buffer.from('vCal-Uid\x01\x00\x00\x00'),
        Buffer.from(e.uid || ''),
        Buffer.from([0])
    ]);
    const goid = Buffer.alloc(40);
    Buffer.from('040000008200E00074C5B7101A82E008', 'hex').copy(goid);
    goid.writeUInt32LE(data.length, 36);
    return n(
        'Email:MeetingRequest',
        version === '14.1'
            ? f('Email:GlobalObjId', Buffer.concat([goid, data]).toString('base64'))
            : f('Calendar:UID', e.uid),
        f('Email2:MeetingMessageType', e.sequence ? 2 : 1),
        f('Email:AllDayEvent', e.allDay ? 1 : 0),
        e.dtstamp ? f('Email:DtStamp', compact(e.dtstamp)) : null,
        e.start ? f('Email:StartTime', compact(e.start)) : null,
        e.end ? f('Email:EndTime', compact(e.end)) : null,
        f('Email:InstanceType', e.instance ? 2 : e.rrule ? 1 : 0),
        f('Email:BusyStatus', e.busy ?? 2),
        version === '14.1'
            ? f('Email:Location', e.location || '')
            : n('AirSyncBase:Location', f('AirSyncBase:DisplayName', e.location || '')),
        f('Email:Organizer', e.organizer?.email || ''),
        f('Email:ResponseRequested', 1),
        e.timezone ? f('Email:TimeZone', e.timezone) : null
    );
};
