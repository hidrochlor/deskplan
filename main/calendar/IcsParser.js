// Turns iCal text (a .ics feed) into plain events the page can use. ical.js does the hard parts: folded lines,
// escaped commas, and times in the feed's own time zones (the FH timetable sends Europe/Vienna with a VTIMEZONE,
// Moodle sends UTC). Times come out as ISO UTC text, so the page never has to know about zones.
const ICAL = require('ical.js');

const DAY = 24 * 60 * 60 * 1000;
const MAX_OCCURRENCES = 400; // a repeating event shows at most this many times...
const REPEAT_HORIZON = 400 * DAY; // ...and only up to about a year ahead

class IcsParser {
  /**
   * @param {string} text  the whole feed
   * @param {{now?: number}} [o]
   * @returns {{name: string, producer: string, events: Array<{uid: string, summary: string, description: string,
   *   location: string, categories: string, start: string, end: string|null}>}}
   * @throws when the text is not an iCal calendar
   */
  static parse(text, { now = Date.now() } = {}) {
    if (!/^\s*BEGIN:VCALENDAR/i.test(String(text))) throw new Error('This address did not return a calendar.');
    let root;
    try {
      root = new ICAL.Component(ICAL.parse(String(text)));
    } catch (err) {
      throw new Error(`The calendar could not be read: ${err.message}`);
    }
    // Zones defined in the feed itself, so TZID=Europe/Vienna times convert correctly.
    for (const zone of root.getAllSubcomponents('vtimezone')) {
      const tz = new ICAL.Timezone(zone);
      if (tz.tzid && !ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(tz.tzid, tz);
    }

    // A moved or changed single occurrence (RECURRENCE-ID) belongs to its repeating event: it is put in place of the
    // occurrence it replaces. A cancelled one removes that occurrence.
    const overrides = new Map(); // uid -> [{ vevent, event, cancelled }]
    const plain = [];
    for (const vevent of root.getAllSubcomponents('vevent')) {
      const cancelled = String(vevent.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';
      const event = new ICAL.Event(vevent);
      if (!event.uid || !event.startDate) continue;
      if (event.recurrenceId) {
        if (!overrides.has(event.uid)) overrides.set(event.uid, []);
        overrides.get(event.uid).push({ vevent, event, cancelled });
      } else if (!cancelled) {
        plain.push({ vevent, event });
      }
    }

    const events = [];
    const used = new Set();
    for (const { vevent, event } of plain) {
      const base = IcsParser.#fields(vevent, event);
      if (!event.isRecurring()) {
        events.push({ ...base, start: iso(event.startDate), end: event.endDate ? iso(event.endDate) : null });
        continue;
      }
      const own = overrides.get(event.uid) ?? [];
      if (own.length) used.add(event.uid);
      const cancelled = new Set();
      for (const o of own) {
        if (o.cancelled) cancelled.add(iso(o.event.recurrenceId));
        else event.relateException(o.event);
      }
      events.push(...IcsParser.#occurrences(event, base, now, cancelled));
    }
    // A change whose repeating event is not in the feed still happens: show it on its own.
    for (const [uid, own] of overrides) {
      if (used.has(uid)) continue;
      for (const { vevent, event, cancelled } of own) {
        if (cancelled) continue;
        const base = IcsParser.#fields(vevent, event);
        events.push({
          ...base, uid: `${base.uid}|${iso(event.recurrenceId)}`,
          start: iso(event.startDate), end: event.endDate ? iso(event.endDate) : null,
        });
      }
    }
    return {
      name: String(root.getFirstPropertyValue('x-wr-calname') ?? '').trim(),
      producer: String(root.getFirstPropertyValue('prodid') ?? '').trim(),
      events,
    };
  }

  static #fields(vevent, event) {
    const categories = vevent.getAllProperties('categories').flatMap((p) => p.getValues()).map(String).join(', ');
    return {
      uid: String(event.uid),
      summary: clean(event.summary),
      description: clean(event.description),
      location: clean(event.location),
      categories: clean(categories),
    };
  }

  /**
   * A repeating event, one entry per occurrence. Each gets its own uid ("<uid>|<original start>") so the page can tell
   * them apart; a moved occurrence keeps the uid of the day it replaced, and takes the changed fields and times.
   */
  static #occurrences(event, base, now, cancelled) {
    const out = [];
    const until = now + REPEAT_HORIZON;
    const it = event.iterator();
    for (let next = it.next(); next && out.length < MAX_OCCURRENCES; next = it.next()) {
      const original = next.toJSDate();
      if (original.getTime() > until) break;
      if (cancelled.has(original.toISOString())) continue;
      const details = event.getOccurrenceDetails(next);
      const changed = details.item !== event;
      const start = details.startDate.toJSDate();
      const end = details.endDate ? details.endDate.toJSDate() : null;
      out.push({
        ...base, ...(changed ? IcsParser.#fields(details.item.component, details.item) : {}),
        uid: `${base.uid}|${original.toISOString()}`,
        start: start.toISOString(), end: end && end > start ? end.toISOString() : null,
      });
    }
    return out;
  }
}

const iso = (time) => time.toJSDate().toISOString();
const clean = (v) => String(v ?? '').replace(/\r\n?/g, '\n').trim();

module.exports = { IcsParser };
