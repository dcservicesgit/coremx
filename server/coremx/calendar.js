'use strict';
const crypto = require('node:crypto');
const codec = require('./calendar-codec');
const { compose } = require('./mime');
const { node: n, child, children, value } = require('./wbxml');
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const uid = () => crypto.randomUUID();
class CalendarService {
    constructor(mail) {
        this.mail = mail;
        this.store = mail.store;
    }
    parseInvitation(parsed) {
        const attachment = parsed.attachments?.find((a) => a.contentType === 'text/calendar');
        if (!attachment) return null;
        try {
            const invitation = codec.parseICS(attachment.content.toString('utf8'));
            const sender = parsed.from?.value?.[0]?.address?.toLowerCase();
            if (!sender) return null;
            if (
                ['REQUEST', 'CANCEL', 'ADD', 'DECLINECOUNTER'].includes(invitation.method) &&
                invitation.event.organizer.email !== sender
            ) {
                if (
                    invitation.method !== 'REQUEST' ||
                    !invitation.event.attendees.some((a) => a.email === sender)
                )
                    return null;
                invitation.forwarded = true;
            }
            invitation.sender = sender;
            invitation.calendarId = hash('calendar:' + invitation.event.uid);
            return invitation;
        } catch {
            return null;
        }
    }
    ingestChanges(scope, invitation) {
        if (!invitation) return [];
        const box = scope.get('mailboxes', scope.mailbox);
        const incoming = invitation.event;
        const existing =
            scope.list('messages', (m) => m.calendar?.uid === incoming.uid)[0] ||
            scope.list('calendarHistory', (m) => m.calendar?.uid === incoming.uid)[0];
        const id = existing?.id || invitation.calendarId;
        const previous = existing || scope.get('messages', id);
        invitation.calendarId = id;
        const folder = scope.list('folders', (f) => f.type === 8)[0];
        if (!folder) return [];
        if (previous?.calendar && previous.calendar.organizer.email !== incoming.organizer.email) return [];
        if ((previous?.calendar?.sequence ?? -1) > incoming.sequence) return [];
        let event;
        if (invitation.forwarded && previous?.calendar) {
            if (!previous.calendar.attendees.some((a) => a.email === invitation.sender)) return [];
            const known = new Set(previous.calendar.attendees.map((a) => a.email));
            event = {
                ...previous.calendar,
                ics: undefined,
                attendees: [
                    ...previous.calendar.attendees,
                    ...incoming.attendees
                        .filter((a) => !known.has(a.email))
                        .map((a) => ({ ...a, status: 'NEEDS-ACTION' }))
                ]
            };
        } else if (['REPLY', 'COUNTER'].includes(invitation.method)) {
            if (
                !previous?.calendar ||
                previous.calendar.organizer.email !== box.email ||
                incoming.sequence !== previous.calendar.sequence
            )
                return [];
            const response = incoming.attendees.find((a) => a.email === invitation.sender);
            if (!response || !previous.calendar.attendees.some((a) => a.email === response.email)) return [];
            event = { ...previous.calendar, ics: undefined };
            if (invitation.method === 'COUNTER')
                event.proposals = {
                    ...(event.proposals || {}),
                    [response.email]: {
                        start: incoming.start,
                        end: incoming.end,
                        at: new Date().toISOString()
                    }
                };
            else if (incoming.instance) {
                if (!codec.hasInstance(event, incoming.instance)) return [];
                const existing = event.exceptions.find((e) => e.instance === incoming.instance) || {
                    instance: incoming.instance
                };
                const attendees = (existing.attendees || event.attendees).map((a) =>
                    a.email === response.email ? { ...a, status: response.status } : a
                );
                event.exceptions = [
                    ...event.exceptions.filter((e) => e.instance !== incoming.instance),
                    { ...existing, attendees }
                ];
            } else
                event.attendees = event.attendees.map((a) =>
                    a.email === response.email ? { ...a, status: response.status } : a
                );
        } else {
            if (!incoming.attendees.some((a) => a.email === box.email) && !previous?.calendar) return [];
            if (invitation.method === 'DECLINECOUNTER') {
                if (!previous?.calendar) return [];
                event = {
                    ...previous.calendar,
                    ics: undefined,
                    proposals: { ...(previous.calendar.proposals || {}) },
                    proposalStatus: 'DECLINED'
                };
                delete event.proposals[box.email];
            } else if (invitation.method === 'CANCEL') {
                if (!previous?.calendar) return [];
                event = { ...previous.calendar, sequence: incoming.sequence, ics: undefined };
                if (incoming.instance)
                    event.exceptions = [
                        ...event.exceptions.filter((e) => e.instance !== incoming.instance),
                        { instance: incoming.instance, deleted: true }
                    ];
                else event.status = 'CANCELLED';
            } else if (['REQUEST', 'PUBLISH', 'ADD'].includes(invitation.method)) {
                if (incoming.instance) {
                    if (!previous?.calendar) return [];
                    event = {
                        ...previous.calendar,
                        sequence: incoming.sequence,
                        ics: undefined,
                        exceptions: [
                            ...previous.calendar.exceptions.filter((e) => e.instance !== incoming.instance),
                            {
                                instance: incoming.instance,
                                start: incoming.start,
                                end: incoming.end,
                                subject: incoming.subject,
                                location: incoming.location
                            }
                        ]
                    };
                } else {
                    const response = previous?.calendar?.attendees.find((a) => a.email === box.email)?.status;
                    const sameSchedule =
                        previous?.calendar?.start === incoming.start &&
                        previous?.calendar?.end === incoming.end &&
                        previous?.calendar?.rrule === incoming.rrule;
                    event = {
                        ...incoming,
                        attendees: incoming.attendees.map((a) =>
                            a.email === box.email
                                ? { ...a, status: sameSchedule && response ? response : 'NEEDS-ACTION' }
                                : a
                        ),
                        busy: response === 'ACCEPTED' && sameSchedule ? incoming.busy : 1
                    };
                }
            } else return [];
        }
        return [
            {
                collection: 'messages',
                id,
                value: {
                    ...previous,
                    mailbox: box.id,
                    folder: folder.id,
                    calendar: event,
                    applicationData: codec.toEas(event),
                    subject: event.subject,
                    date: event.start,
                    size: 0
                }
            }
        ];
    }
    async prepare(auth, notifications) {
        const queued = [];
        for (const notification of notifications) {
            if (!notification.to.length) continue;
            const bytes = await compose({
                from: auth.mailbox.email,
                to: notification.to,
                subject: notification.subject || notification.event.subject,
                text: notification.text || notification.event.body || notification.event.subject,
                icalEvent: {
                    method: notification.method,
                    content: codec.toICS(
                        notification.event,
                        notification.method,
                        notification.attendeeOnly,
                        notification.instance
                    )
                }
            });
            queued.push({
                id: uid(),
                mailbox: auth.mailbox.id,
                sender: auth.mailbox.email,
                recipients: notification.to,
                blob: await this.store.putBlob(bytes),
                size: bytes.length,
                saveInSent: true,
                status: 'pending',
                attempts: 0,
                nextAttempt: 0
            });
        }
        return queued;
    }
    async commit(auth, operation, notifications, build) {
        if (this.store.operations.has(operation)) return;
        const scope = this.store.forMailbox(auth.mailbox.id);
        const queued = await this.prepare(auth, notifications);
        await scope.transaction(operation, (store) => {
            const box = store.get('mailboxes', auth.mailbox.id);
            const pending = store
                .list('outbox', (e) => e.status === 'pending')
                .reduce((sum, e) => sum + (e.reservedBytes ?? e.size), 0);
            if (
                !box.enabled ||
                box.usedBytes + pending + queued.reduce((sum, e) => sum + (e.reservedBytes ?? e.size), 0) >
                    box.quotaBytes
            )
                throw new Error('Mailbox quota exceeded');
            return [
                ...build(store),
                ...queued.map((entry) => ({ collection: 'outbox', id: entry.id, value: entry }))
            ];
        });
    }
    async save(auth, input) {
        const scope = this.store.forMailbox(auth.mailbox.id);
        const eventUid = input.uid || hash(auth.mailbox.id + ':' + (input.clientId || uid()));
        const id = input.id || hash('calendar:' + eventUid);
        const operation = 'calendar-save:' + auth.mailbox.id + ':' + (input.clientId || uid());
        if (this.store.operations.has(operation)) return scope.get('messages', id);
        const previous = scope.get('messages', id);
        if (previous && (!previous.calendar || previous.calendar.organizer.email !== auth.mailbox.email))
            throw new Error('Only the organizer can update this meeting');
        if (previous && input.revision !== previous.revision)
            throw new Error('Calendar changed; refresh before saving');
        const event = codec.validate({
            ...previous?.calendar,
            ...input,
            uid: previous?.calendar?.uid || eventUid,
            organizer: { email: auth.mailbox.email, name: auth.mailbox.displayName || auth.mailbox.email },
            sequence: previous ? previous.calendar.sequence + 1 : 0,
            status: 'CONFIRMED',
            dtstamp: new Date().toISOString(),
            exceptions: input.exceptions || previous?.calendar?.exceptions || [],
            attendees: input.attendees || previous?.calendar?.attendees || [],
            ics: undefined
        });
        if (
            previous &&
            (previous.calendar.start !== event.start ||
                previous.calendar.end !== event.end ||
                previous.calendar.rrule !== event.rrule)
        ) {
            event.attendees = event.attendees.map((a) => ({ ...a, status: 'NEEDS-ACTION' }));
            event.proposals = {};
        }
        const folder = scope.list('folders', (f) => f.type === 8)[0];
        const to = event.attendees.filter((a) => a.email !== auth.mailbox.email).map((a) => a.email);
        const removed = (previous?.calendar.attendees || [])
            .filter((a) => !to.includes(a.email) && a.email !== auth.mailbox.email)
            .map((a) => a.email);
        await this.commit(
            auth,
            operation,
            [
                { event, to, method: 'REQUEST' },
                ...(removed.length
                    ? [
                          {
                              event: { ...previous.calendar, sequence: event.sequence },
                              to: removed,
                              method: 'CANCEL'
                          }
                      ]
                    : [])
            ],
            (store) => {
                if (store.get('messages', id)?.revision !== previous?.revision)
                    throw new Error('Calendar changed; retry');
                return [
                    {
                        collection: 'messages',
                        id,
                        value: {
                            mailbox: auth.mailbox.id,
                            folder: folder.id,
                            calendar: event,
                            applicationData: codec.toEas(event),
                            date: event.start,
                            subject: event.subject,
                            size: 0
                        }
                    }
                ];
            }
        );
        return scope.get('messages', id);
    }
    async cancel(auth, id, revision, instance) {
        const scope = this.store.forMailbox(auth.mailbox.id);
        const item = scope.get('messages', id);
        if (
            !item?.calendar ||
            item.calendar.organizer.email !== auth.mailbox.email ||
            item.revision !== revision
        )
            throw new Error('Meeting unavailable or changed');
        const event = {
            ...item.calendar,
            ics: undefined,
            sequence: item.calendar.sequence + 1,
            dtstamp: new Date().toISOString()
        };
        if (instance && !codec.hasInstance(event, instance)) throw new Error('Meeting instance unavailable');
        if (instance)
            event.exceptions = [
                ...event.exceptions.filter((e) => e.instance !== instance),
                { instance, deleted: true }
            ];
        else event.status = 'CANCELLED';
        await this.commit(
            auth,
            `calendar-cancel:${auth.mailbox.id}:${id}:${revision}:${instance || 'series'}`,
            [
                {
                    event,
                    to: event.attendees.map((a) => a.email).filter((email) => email !== auth.mailbox.email),
                    method: 'CANCEL',
                    instance
                }
            ],
            (store) => {
                if (store.get('messages', id)?.revision !== revision) throw new Error('Meeting changed');
                return [
                    {
                        collection: 'messages',
                        id,
                        value: { ...item, calendar: event, applicationData: codec.toEas(event) }
                    }
                ];
            }
        );
        return { cancelled: true };
    }
    async respond(auth, sourceId, response, options = {}) {
        if (!['ACCEPTED', 'TENTATIVE', 'DECLINED'].includes(response))
            throw new Error('Invalid meeting response');
        const scope = this.store.forMailbox(auth.mailbox.id);
        const source = scope.get('messages', sourceId);
        const id = source?.meeting?.calendarId || sourceId;
        const item = scope.get('messages', id) || scope.get('calendarHistory', id);
        if (!item?.calendar || item.calendar.status === 'CANCELLED') throw new Error('Meeting unavailable');
        const previous = item.calendar;
        if (source?.meeting && source.meeting.event.sequence < previous.sequence)
            throw new Error('Invitation was superseded');
        if (options.instance) {
            options.instance = require('./timezone').date(options.instance).toISOString();
            if (!codec.hasInstance(previous, options.instance))
                throw new Error('Meeting instance unavailable');
        }
        if (
            !!options.proposedStart !== !!options.proposedEnd ||
            (options.proposedStart && previous.disallowNewTimeProposal)
        )
            throw new Error('Invalid time proposal');
        const attendee = previous.attendees.find((a) => a.email === auth.mailbox.email);
        if (!attendee || previous.organizer.email === auth.mailbox.email)
            throw new Error('Invitation does not belong to this mailbox');
        if (attendee.status === response && !options.instance && !options.proposedStart)
            return { id, response };
        let event = {
            ...previous,
            ics: undefined,
            dtstamp: new Date().toISOString(),
            attendees: previous.attendees.map((a) =>
                a.email === auth.mailbox.email ? { ...a, status: response } : a
            ),
            busy: response === 'ACCEPTED' ? 2 : response === 'TENTATIVE' ? 1 : 0,
            responseType: { ACCEPTED: 3, TENTATIVE: 2, DECLINED: 4 }[response],
            appointmentReplyTime: new Date().toISOString()
        };
        if (options.instance)
            event.exceptions = [
                ...event.exceptions.filter((e) => e.instance !== options.instance),
                { instance: options.instance, response, deleted: response === 'DECLINED' }
            ];
        if (options.proposedStart) {
            options.proposedStart = require('./timezone').date(options.proposedStart).toISOString();
            options.proposedEnd = require('./timezone').date(options.proposedEnd).toISOString();
        }
        if (options.proposedStart)
            event = codec.validate({
                ...event,
                start: options.proposedStart,
                end: options.proposedEnd,
                rrule: null,
                exceptions: []
            });
        const notifications =
            options.sendResponse === false
                ? []
                : [
                      {
                          event,
                          to: [event.organizer.email],
                          method: options.proposedStart ? 'COUNTER' : 'REPLY',
                          attendeeOnly: auth.mailbox.email,
                          text: options.body,
                          instance: options.instance
                      }
                  ];
        await this.commit(
            auth,
            `calendar-response:${auth.device.id}:${id}:${item.revision}:${response}:${options.instance || ''}`,
            notifications,
            (store) => {
                if (
                    (store.get('messages', id) || store.get('calendarHistory', id))?.revision !==
                    item.revision
                )
                    throw new Error('Meeting changed');
                if (options.instance) event.attendees = previous.attendees;
                const updated = options.proposedStart
                    ? {
                          ...previous,
                          proposals: {
                              ...(previous.proposals || {}),
                              [auth.mailbox.email]: { start: options.proposedStart, end: options.proposedEnd }
                          }
                      }
                    : event;
                const stored = { ...item, calendar: updated, applicationData: codec.toEas(updated) };
                const decline = response === 'DECLINED' && !options.instance && !options.proposedStart;
                return [
                    { collection: 'messages', id, value: decline ? null : stored },
                    { collection: 'calendarHistory', id, value: decline ? stored : null },
                    ...(source?.blob
                        ? [
                              {
                                  collection: 'messages',
                                  id: source.id,
                                  value: { ...source, read: true, meetingResponse: response }
                              }
                          ]
                        : [])
                ];
            }
        );
        return { id, response };
    }
    async declineProposal(auth, id, email, revision) {
        const scope = this.store.forMailbox(auth.mailbox.id),
            item = scope.get('messages', id);
        if (
            !item?.calendar ||
            item.calendar.organizer.email !== auth.mailbox.email ||
            item.revision !== revision ||
            !item.calendar.proposals?.[email]
        )
            throw new Error('Proposal unavailable or changed');
        const proposal = item.calendar.proposals[email],
            proposals = { ...item.calendar.proposals };
        delete proposals[email];
        const event = { ...item.calendar, proposals, ics: undefined };
        await this.commit(
            auth,
            `decline-proposal:${auth.mailbox.id}:${id}:${revision}:${email}`,
            [
                {
                    event: {
                        ...event,
                        start: proposal.start,
                        end: proposal.end,
                        rrule: null,
                        exceptions: []
                    },
                    to: [email],
                    method: 'DECLINECOUNTER'
                }
            ],
            (store) => {
                if (store.get('messages', id)?.revision !== revision) throw new Error('Meeting changed');
                return [
                    {
                        collection: 'messages',
                        id,
                        value: { ...item, calendar: event, applicationData: codec.toEas(event) }
                    }
                ];
            }
        );
        return { declined: true };
    }
    list(auth, from, to) {
        if (
            !Number.isFinite(Date.parse(from)) ||
            !Number.isFinite(Date.parse(to)) ||
            Date.parse(to) <= Date.parse(from) ||
            Date.parse(to) - Date.parse(from) > 366 * 86400000
        )
            throw new Error('Calendar query is limited to one year');
        const result = [];
        for (const item of this.store.forMailbox(auth.mailbox.id).list('messages', (m) => !!m.calendar)) {
            result.push(
                ...codec
                    .occurrences(item.calendar, from, to)
                    .map((event) => ({ ...event, id: item.id, revision: item.revision }))
            );
            if (result.length > 10000) throw new Error('Narrow the calendar query window');
        }
        return result;
    }
    async forward(auth, item, root) {
        const event =
            item.calendar ||
            this.store.forMailbox(auth.mailbox.id).get('messages', item.meeting?.calendarId)?.calendar;
        if (!event) throw new Error('Calendar source required');
        const address = require('./mail').address;
        const clientId = value(root, 'ComposeMail:ClientId');
        if (!clientId || clientId.length > 128) throw new Error('Client ID required');
        const instanceText = value(child(root, 'ComposeMail:Source'), 'ComposeMail:InstanceId');
        const instance = instanceText ? require('./timezone').date(instanceText).toISOString() : undefined;
        if (instance && !codec.hasInstance(event, instance)) throw new Error('Meeting instance unavailable');
        const to = children(child(root, 'ComposeMail:Forwardees'), 'ComposeMail:Forwardee').map((f) =>
            address(value(f, 'ComposeMail:Email'))
        );
        if (!to.length || to.length > 100) throw new Error('Invalid forwardees');
        // Forwarded requests retain organizer identity in iCalendar; the SMTP sender
        // is the forwarding mailbox. They do not grant organizer editing rights.
        await this.commit(
            auth,
            'calendar-forward:' + auth.device.id + ':' + value(root, 'ComposeMail:ClientId'),
            [
                {
                    event: {
                        ...event,
                        attendees: [
                            ...event.attendees,
                            ...to.map((email) => ({ email, status: 'NEEDS-ACTION' }))
                        ]
                    },
                    to: [...new Set([...to, event.organizer.email])].filter(
                        (email) => email !== auth.mailbox.email
                    ),
                    method: 'REQUEST',
                    instance,
                    text: value(child(root, 'AirSyncBase:Body'), 'AirSyncBase:Data')
                }
            ],
            () => []
        );
        return null;
    }
}
module.exports = { CalendarService };
