import { formatDate } from '../../core/dates.js';

// Repeating tasks and assignments (docs/protocol.md section 4 "Repeating items"). An item with a `repeat` rule
//   { every: 'day' | 'week' | 'month', interval: 1..12, until: ISO text | null }
// gets its next copy when it is ticked off: same title, kind, place, details and rule, its times moved on by the rule
// until the due time is in the future (missed ones are skipped), not done. Steps inside an assignment are not copied.
// The copy's id comes from the item's id (nextId), the same on the PC and the phone, so when both make it they make
// the same item and the usual "last edit wins" merges them: never two copies. Unticking one whose time is still ahead
// takes its copy back (#takeBack), as long as that copy is the latest and not done.
// An occurrence whose time passes unticked moves the series on all the same (auto-advance): its next copy is made and
// it stays to do (missed). The copies of one item are a series (seriesOf): shown once, with their timeline.
export const REPEAT_EVERY = ['day', 'week', 'month'];
export const MAX_INTERVAL = 12;
const MAX_STEPS = 1000; // how far a long-missed series may catch up
const MAX_ID = 64;
const ROOT_MAX = 52;
const COPY = /^(.*)\.r(\d+)$/;

const EVERY_WORDS = { day: ['Daily', 'days'], week: ['Weekly', 'weeks'], month: ['Monthly', 'months'] };

/** "Weekly", "Every 2 weeks", "Daily until Dec 18". */
export function repeatText(repeat) {
  const [one, many] = EVERY_WORDS[repeat.every] ?? EVERY_WORDS.week;
  const base = (repeat.interval ?? 1) === 1 ? one : `Every ${repeat.interval} ${many}`;
  if (!repeat.until) return base;
  return `${base} until ${formatDate(new Date(repeat.until))}`;
}

/** A valid rule, normalised, or undefined when it is not one. null (no repeat) stays null. */
export function readRepeat(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { every, interval = 1, until = null } = value;
  if (!REPEAT_EVERY.includes(every)) return undefined;
  if (!Number.isInteger(interval) || interval < 1 || interval > MAX_INTERVAL) return undefined;
  if (until !== null && (typeof until !== 'string' || Number.isNaN(Date.parse(until)))) return undefined;
  return { every, interval, until: until === null ? null : new Date(until).toISOString() };
}

/** "abc" -> "abc.r1", "abc.r1" -> "abc.r2". A root too long to fit is cut to its first 52 characters. */
export function nextId(id) {
  const m = String(id).match(COPY);
  const root = m ? m[1] : String(id);
  const n = m ? Number(m[2]) + 1 : 1;
  const next = `${root}.r${n}`;
  return next.length <= MAX_ID ? next : `${root.slice(0, ROOT_MAX)}.r${n}`;
}

/** "abc.r3" -> "abc", "abc" -> "abc": the id every copy of a series shares. */
export function rootOf(id) {
  const m = String(id).match(COPY);
  return m ? m[1] : String(id);
}

/** "abc" -> 0, "abc.r3" -> 3: where a copy comes in its series. */
export function numberOf(id) {
  const m = String(id).match(COPY);
  return m ? Number(m[2]) : 0;
}

/** `date` moved on by `steps` of the rule, in local time (a 9:00 lecture stays at 9:00 across a clock change). */
function shift(date, { every, interval }, steps) {
  const d = new Date(date.getTime());
  if (every === 'day') d.setDate(d.getDate() + interval * steps);
  else if (every === 'week') d.setDate(d.getDate() + 7 * interval * steps);
  else {
    // The 31st in a shorter month falls on its last day, without drifting for the months after.
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + interval * steps);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
  }
  return d;
}

/**
 * The next copy's times, or null when the series has ended (past `until`). `deadline` and `start` are ISO text (start
 * may be null); the answer moves both by the same steps, the fewest that put the due time after `now`.
 */
export function nextDates({ deadline, start = null, repeat }, now) {
  const due = new Date(deadline);
  if (Number.isNaN(due.getTime())) return null;
  let steps = 1;
  while (shift(due, repeat, steps).getTime() <= now && steps < MAX_STEPS) steps++;
  const nextDue = shift(due, repeat, steps);
  if (repeat.until && nextDue.getTime() > Date.parse(repeat.until)) return null;
  return { deadline: nextDue.toISOString(), start: start ? shift(new Date(start), repeat, steps).toISOString() : null };
}

/** Can this item repeat? A task or assignment with a due time, not imported from a feed (the feed owns its dates). */
export function canRepeat(item) {
  return (item.kind === 'task' || item.kind === 'assignment') && !!item.deadline && !item.source;
}

/** The next copy of `item` as fields for Collection.add, or null when there is none (no rule, ended, or already made). */
export function nextCopy(item, items, now) {
  const repeat = item.repeat ? readRepeat(item.repeat) : null;
  if (!repeat || !canRepeat(item)) return null;
  const id = nextId(item.id);
  if (items.get(id)) return null;
  const dates = nextDates({ deadline: item.deadline, start: item.start, repeat }, now);
  if (!dates) return null;
  return {
    id, kind: item.kind, title: item.title, parentId: item.parentId ?? null, description: item.description ?? '',
    deadline: dates.deadline, start: dates.start, repeat, status: 'todo', completedAt: null,
  };
}

/**
 * The copies due because an occurrence ended without being ticked off (auto-advance), as fields for Collection.add.
 * Only a series' latest copy qualifies: the older ones' next ids exist already.
 */
export function dueCopies(items, now) {
  const copies = [];
  for (const item of items.all()) {
    if (item.isDone || !item.repeat || !item.deadline || Date.parse(item.deadline) > now) continue;
    const copy = nextCopy(item, items, now);
    if (copy && !copies.some((c) => c.id === copy.id)) copies.push(copy);
  }
  return copies;
}

/**
 * The repeating series among `list` (items): copies sharing a root id where at least one has a rule, as Series.
 * Soonest latest due time first, ended ones last.
 */
export function seriesOf(list, now = Date.now()) {
  const byRoot = new Map();
  for (const item of list) {
    if (item.kind !== 'task' && item.kind !== 'assignment') continue;
    const root = rootOf(item.id);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(item);
  }
  const series = [];
  for (const [root, members] of byRoot) {
    if (!members.some((m) => m.repeat)) continue;
    members.sort((a, b) => numberOf(a.id) - numberOf(b.id));
    series.push(new Series(root, members));
  }
  const due = (s) => (s.latest.deadline ? Date.parse(s.latest.deadline) : Infinity);
  return series.sort((a, b) => (a.ended(now) - b.ended(now)) || (due(a) - due(b)));
}

/**
 * One repeating item and its copies (the ids equal once ".rN" is removed), oldest first. The last is the current one:
 * the next to happen, or the last that happened when the series has ended.
 */
export class Series {
  constructor(root, members) {
    this.root = root;
    this.members = members;
  }

  get latest() { return this.members[this.members.length - 1]; }

  /** The rule the next copies are made by (the latest copy's), or null. */
  get rule() { return this.latest.repeat ? readRepeat(this.latest.repeat) : null; }

  has(id) { return this.members.some((m) => m.id === id); }

  /** No more copies to come: the rule was removed, or the latest is done or over and nothing follows before `until`. */
  ended(now = Date.now()) {
    const { latest, rule } = this;
    if (!rule || !latest.deadline) return true;
    if (!latest.isDone && Date.parse(latest.deadline) > now) return false;
    return nextDates({ deadline: latest.deadline, start: latest.start, repeat: rule }, now) === null;
  }

  /**
   * Up to `max` times after the latest copy that its rule will make, as { start, deadline } ISO text, stopping at
   * `until` and at `horizon` (ms). Not stored: shown ahead (the calendar, the timeline).
   */
  upcoming({ max = 12, horizon = Infinity } = {}) {
    const { latest, rule } = this;
    if (!rule || !canRepeat(latest)) return [];
    const until = rule.until ? Date.parse(rule.until) : Infinity;
    const out = [];
    for (let step = 1; out.length < max; step++) {
      const due = shift(new Date(latest.deadline), rule, step);
      if (due.getTime() > until || due.getTime() > horizon) break;
      out.push({ deadline: due.toISOString(), start: latest.start ? shift(new Date(latest.start), rule, step).toISOString() : null });
    }
    return out;
  }

  /**
   * The copies still ahead of `now` (ticked off early), as [id, patch] pairs that make them follow the latest copy after
   * an edit there: the same title, details and rule, and times one step of the rule apart, counted back from the latest.
   * Only those that differ are answered. The ones whose time has passed are history and keep what they were.
   */
  followers(now = Date.now()) {
    const { members, latest, rule } = this;
    if (!rule || !latest.deadline) return [];
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const out = [];
    let steps = 0;
    for (let i = members.length - 2; i >= 0; i--) {
      const m = members[i];
      if (!m.deadline || Date.parse(m.deadline) <= now) break;
      steps--;
      const patch = {
        title: latest.title,
        description: latest.description ?? '',
        repeat: rule,
        start: latest.start ? shift(new Date(latest.start), rule, steps).toISOString() : null,
        deadline: shift(new Date(latest.deadline), rule, steps).toISOString(),
      };
      const was = {
        title: m.title, description: m.description ?? '', repeat: m.repeat ? readRepeat(m.repeat) : null,
        start: m.start ? new Date(m.start).toISOString() : null, deadline: new Date(m.deadline).toISOString(),
      };
      if (!same(patch, was)) out.push([m.id, patch]);
    }
    return out;
  }
}

/** Makes the next copy whenever a repeating item becomes done, however that happened (a tick, the editor, the phone). */
export class Repeats {
  /** @param {{store: object, bus: object, now?: () => number}} o */
  constructor({ store, bus, now = Date.now }) {
    this.store = store;
    this.bus = bus;
    this.now = now;
    this.done = new Set();
  }

  /**
   * Call once the saved items are loaded: what is already done then is not a change. Occurrences that passed unticked
   * move their series on now, and every minute after.
   */
  start() {
    const items = this.store.collection('items');
    this.done = new Set(items.all().filter((i) => i.isDone).map((i) => i.id));
    this.bus.on('data:changed', (e) => this.#onChange(e));
    this.advance();
    this.timer = setInterval(() => this.advance(), 60000);
    this.timer.unref?.(); // never keeps a test run alive
  }

  stop() { clearInterval(this.timer); }

  /** An edit of a series' latest copy reaches its copies still ahead too, so the calendar shows no stale ones. */
  #follow(item, items) {
    if (!item.repeat || items.get(nextId(item.id))) return;
    const root = rootOf(item.id);
    const series = seriesOf(items.all().filter((i) => rootOf(i.id) === root), this.now())[0];
    if (!series) return;
    for (const [id, patch] of series.followers(this.now())) items.update(id, patch);
  }

  /**
   * Unticked while its time is still ahead: the copy its tick made goes again, so it is the next one once more. Only
   * while that copy is the series' latest and not done (nothing was built on it); a past one just counts as missed.
   */
  #takeBack(item, items) {
    if (!item.repeat || !item.deadline || Date.parse(item.deadline) <= this.now()) return;
    const copy = items.get(nextId(item.id));
    if (!copy || copy.isDone || items.get(nextId(copy.id))) return;
    items.remove(copy.id);
  }

  /** Makes the copies due because an occurrence ended unticked (dueCopies). */
  advance() {
    const items = this.store.collection('items');
    for (const copy of dueCopies(items, this.now())) {
      if (!items.get(copy.id)) items.add(copy);
    }
  }

  #onChange({ collection, type, id }) {
    if (collection !== 'items') return;
    if (type === 'remove') { this.done.delete(id); return; }
    const items = this.store.collection('items');
    const item = items.get(id);
    if (!item) return;
    this.#follow(item, items);
    if (!item.isDone) {
      if (this.done.delete(id)) this.#takeBack(item, items);
      return;
    }
    if (this.done.has(id)) return;
    this.done.add(id);
    const copy = nextCopy(item, items, this.now());
    if (copy) items.add(copy);
  }
}
