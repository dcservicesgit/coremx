'use strict';
const codec = require('./calendar-codec');
// Called inside the Sync transaction; notifications and calendar revisions commit together.
module.exports = async (eas, auth, previous, updated, remove = false, instance) => {
    const old = previous?.calendar;
    if (old?.organizer?.email && old.organizer.email !== auth.mailbox.email) {
        if (remove) return [];
        const before = { ...old, reminder: undefined, body: undefined, dtstamp: undefined, ics: undefined };
        const after = {
            ...updated.calendar,
            reminder: undefined,
            body: undefined,
            dtstamp: undefined,
            ics: undefined
        };
        if (JSON.stringify(before) !== JSON.stringify(after))
            throw new Error('Organizer owns meeting details');
        return [];
    }
    if (!updated && !old) return [];
    const event = {
        ...(remove && !instance ? old : updated.calendar),
        organizer: { email: auth.mailbox.email, name: auth.mailbox.displayName || auth.mailbox.email },
        sequence: old ? (old.sequence || 0) + 1 : 0,
        dtstamp: new Date().toISOString(),
        ics: undefined
    };
    if (!event.attendees?.length && !old?.attendees?.length) {
        if (updated) updated.calendar = event;
        return [];
    }
    codec.validate(event);
    const recipients = event.attendees.map((a) => a.email).filter((email) => email !== auth.mailbox.email);
    const removed = (old?.attendees || [])
        .map((a) => a.email)
        .filter((email) => email !== auth.mailbox.email && !recipients.includes(email));
    const queued = await eas.mail.calendar.prepare(auth, [
        { event, to: recipients, method: remove ? 'CANCEL' : 'REQUEST', instance },
        ...(removed.length
            ? [{ event: { ...old, sequence: event.sequence }, to: removed, method: 'CANCEL' }]
            : [])
    ]);
    if (updated) {
        updated.calendar = event;
        updated.applicationData = codec.toEas(event, auth.protocolVersion);
    }
    return queued;
};
