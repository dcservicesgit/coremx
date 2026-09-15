'use strict';
const ICAL = require('./central')('node_modules/ical.js').default;
const { base64 } = require('./mime');
const DAY = 86400000;
function date(value) {
    if (typeof value !== 'string') throw new Error('Calendar date required');
    const normalized = value.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z');
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(normalized))
        throw new Error('UTC calendar date required');
    const parsed = new Date(normalized);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== normalized.slice(0, 19))
        throw new Error('Invalid calendar date');
    return parsed;
}
const compact = (value) =>
    date(value instanceof Date ? value.toISOString() : value)
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, 'Z');
function systemTime(bytes, offset) {
    const [year, month, weekday, week, hour, minute, second, ms] = Array.from({ length: 8 }, (_, i) =>
        bytes.readUInt16LE(offset + i * 2)
    );
    if (
        year ||
        month > 12 ||
        weekday > 6 ||
        (month && (week < 1 || week > 5)) ||
        hour > 23 ||
        minute > 59 ||
        second > 59 ||
        ms > 999
    )
        throw new Error('Invalid timezone transition');
    return { month, weekday, week, hour, minute, second, ms };
}
function decodeZone(encoded) {
    if (!encoded) return null;
    const bytes = base64(encoded, 172);
    if (bytes.length !== 172) throw new Error('Timezone must contain 172 bytes');
    const zone = {
        bias: bytes.readInt32LE(0),
        standard: bytes.readInt32LE(84),
        daylight: bytes.readInt32LE(168),
        standardDate: systemTime(bytes, 68),
        daylightDate: systemTime(bytes, 152),
        binary: encoded
    };
    if (
        [zone.bias, zone.standard, zone.daylight, zone.bias + zone.standard, zone.bias + zone.daylight].some(
            (n) => Math.abs(n) > 1440
        ) ||
        !!zone.standardDate.month !== !!zone.daylightDate.month
    )
        throw new Error('Invalid timezone bias');
    return zone;
}
function transition(rule, year) {
    const first = new Date(Date.UTC(year, rule.month - 1, 1));
    let day = 1 + ((rule.weekday - first.getUTCDay() + 7) % 7) + 7 * (rule.week - 1);
    const last = new Date(Date.UTC(year, rule.month, 0)).getUTCDate();
    if (day > last) day -= 7;
    return Date.UTC(year, rule.month - 1, day, rule.hour, rule.minute, rule.second, rule.ms);
}
const formatters = new Map();
function formatter(zone) {
    if (!formatters.has(zone)) {
        if (formatters.size >= 128) formatters.delete(formatters.keys().next().value);
        formatters.set(
            zone,
            new Intl.DateTimeFormat('en-GB', {
                timeZone: zone,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hourCycle: 'h23'
            })
        );
    }
    return formatters.get(zone);
}
function offsetAt(instant, zone = 'UTC', binary) {
    if (binary) {
        const rule = typeof binary === 'string' ? decodeZone(binary) : binary;
        if (!rule.standardDate.month) return -(rule.bias + rule.standard) * 60000;
        const year = new Date(instant).getUTCFullYear();
        const daylight = transition(rule.daylightDate, year) + (rule.bias + rule.standard) * 60000;
        const standard = transition(rule.standardDate, year) + (rule.bias + rule.daylight) * 60000;
        const summer =
            daylight < standard
                ? instant >= daylight && instant < standard
                : instant >= daylight || instant < standard;
        return -(rule.bias + (summer ? rule.daylight : rule.standard)) * 60000;
    }
    const parts = Object.fromEntries(
        formatter(zone)
            .formatToParts(new Date(instant))
            .map((p) => [p.type, p.value])
    );
    return (
        Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) -
        Math.floor(instant / 1000) * 1000
    );
}
function wallTime(instant, zone, binary) {
    return new Date(instant + offsetAt(instant, zone, binary)).toISOString().slice(0, 19);
}
function fromWall(wall, zone = 'UTC', binary) {
    const local = date(wall + 'Z').getTime();
    // Prefer the earlier instant in an overlap, as required for iCalendar local times.
    const offsets = new Set([-DAY, 0, DAY].map((delta) => offsetAt(local + delta, zone, binary)));
    const valid = [...offsets]
        .map((offset) => local - offset)
        .filter((instant) => wallTime(instant, zone, binary) === wall)
        .sort((a, b) => a - b);
    if (valid.length) return valid[0];
    // A time in a spring-forward gap uses the offset before the gap (RFC 5545).
    return local - offsetAt(local - DAY, zone, binary);
}
const encodedZones = new Map();
function encodeZone(zone = 'UTC', instant = Date.now()) {
    const cacheKey = zone + ':' + new Date(instant).getUTCFullYear();
    if (encodedZones.has(cacheKey)) return encodedZones.get(cacheKey);
    formatter(zone);
    const bytes = Buffer.alloc(172);
    const year = new Date(instant).getUTCFullYear();
    const start = Date.UTC(year, 0, 1);
    const end = Date.UTC(year + 1, 0, 1);
    const changes = [];
    let previous = offsetAt(start, zone);
    for (let day = start + DAY; day <= end; day += DAY) {
        const offset = offsetAt(day, zone);
        if (offset !== previous) {
            let lo = day - DAY,
                hi = day;
            while (hi - lo > 1000) {
                const middle = Math.floor((lo + hi) / 2000) * 1000;
                if (offsetAt(middle, zone) === previous) lo = middle;
                else hi = middle;
            }
            changes.push({ at: hi, from: previous, to: offset });
            previous = offset;
        }
    }
    const standard = Math.min(offsetAt(start, zone), ...changes.map((c) => c.to));
    bytes.writeInt32LE(-standard / 60000, 0);
    bytes.write(zone.slice(0, 31), 4, 'utf16le');
    const daylight = changes.find((c) => c.to > c.from);
    const winter = changes.find((c) => c.to < c.from);
    if (daylight && winter) {
        bytes.writeInt32LE(-(daylight.to - standard) / 60000, 168);
        for (const [change, offset] of [
            [winter, 68],
            [daylight, 152]
        ]) {
            const local = new Date(change.at + change.from);
            const last = new Date(Date.UTC(year, local.getUTCMonth() + 1, 0)).getUTCDate();
            const week = local.getUTCDate() + 7 > last ? 5 : Math.ceil(local.getUTCDate() / 7);
            [
                0,
                local.getUTCMonth() + 1,
                local.getUTCDay(),
                week,
                local.getUTCHours(),
                local.getUTCMinutes(),
                local.getUTCSeconds(),
                0
            ].forEach((v, i) => bytes.writeUInt16LE(v, offset + i * 2));
        }
    }
    const encoded = bytes.toString('base64');
    if (encodedZones.size >= 256) encodedZones.delete(encodedZones.keys().next().value);
    encodedZones.set(cacheKey, encoded);
    return encoded;
}
function zoneComponent(encoded) {
    const rule = decodeZone(encoded);
    if (!rule) return null;
    const id =
        'CoreMX/' + require('node:crypto').createHash('sha256').update(encoded).digest('hex').slice(0, 16);
    const component = new ICAL.Component('vtimezone');
    component.addPropertyWithValue('tzid', id);
    const offset = (minutes) => ICAL.UtcOffset.fromSeconds(-minutes * 60);
    for (const [kind, transitionRule, from, to] of [
        ['standard', rule.standardDate, rule.daylight, rule.standard],
        ['daylight', rule.daylightDate, rule.standard, rule.daylight]
    ]) {
        if (kind === 'daylight' && !transitionRule.month) continue;
        const sub = new ICAL.Component(kind);
        sub.addPropertyWithValue(
            'dtstart',
            ICAL.Time.fromString(
                new Date(transitionRule.month ? transition(transitionRule, 2000) : Date.UTC(2000, 0, 1))
                    .toISOString()
                    .slice(0, 19)
            )
        );
        sub.addPropertyWithValue('tzoffsetfrom', offset(rule.bias + (transitionRule.month ? from : to)));
        sub.addPropertyWithValue('tzoffsetto', offset(rule.bias + to));
        if (transitionRule.month)
            sub.addPropertyWithValue(
                'rrule',
                ICAL.Recur.fromString(
                    `FREQ=YEARLY;BYMONTH=${transitionRule.month};BYDAY=${transitionRule.week === 5 ? -1 : transitionRule.week}${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][transitionRule.weekday]}`
                )
            );
        component.addSubcomponent(sub);
    }
    return component;
}
module.exports = { ICAL, date, compact, decodeZone, encodeZone, offsetAt, wallTime, fromWall, zoneComponent };
module.exports.fromComponent = function fromComponent(component) {
    const standard = component.getFirstSubcomponent('standard');
    const daylight = component.getFirstSubcomponent('daylight');
    if (!standard) throw new Error('Timezone standard definition required');
    const bytes = Buffer.alloc(172);
    const standardOffset = standard.getFirstPropertyValue('tzoffsetto')?.toSeconds();
    if (!Number.isFinite(standardOffset) || standardOffset % 60)
        throw new Error('Unsupported timezone precision');
    bytes.writeInt32LE(-standardOffset / 60, 0);
    if (daylight) {
        const daylightOffset = daylight.getFirstPropertyValue('tzoffsetto')?.toSeconds();
        bytes.writeInt32LE(-(daylightOffset - standardOffset) / 60, 168);
        for (const [sub, offset] of [
            [standard, 68],
            [daylight, 152]
        ]) {
            const start = sub.getFirstPropertyValue('dtstart');
            const rule = sub.getFirstPropertyValue('rrule');
            const byday = rule?.getComponent('BYDAY')?.[0];
            const match = /^(-?[1-5])(SU|MO|TU|WE|TH|FR|SA)$/.exec(byday || '');
            const month = rule?.getComponent('BYMONTH')?.[0] || start.month;
            const week = match ? (+match[1] === -1 ? 5 : +match[1]) : Math.ceil(start.day / 7);
            const weekday = match
                ? ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'].indexOf(match[2])
                : start.dayOfWeek() - 1;
            [0, month, weekday, week, start.hour, start.minute, start.second, 0].forEach((v, index) =>
                bytes.writeUInt16LE(v, offset + index * 2)
            );
        }
    }
    decodeZone(bytes.toString('base64'));
    return bytes.toString('base64');
};
