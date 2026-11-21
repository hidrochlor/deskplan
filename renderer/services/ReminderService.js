import { HOUR, MINUTE } from '../core/dates.js';
import { NextEventLabel } from './NextEventLabel.js';

// Desktop notifications for any CalendarEvent.
// A deadline: 24h before, 1h before, and at the due time.
export const REMINDER_STEPS = [
  { key: '24h', before: 24 * HOUR },
  { key: '1h', before: HOUR },
  { key: 'due', before: 0 },
];

// A time block: 10 minutes before it starts, and when it ends. Settings › Notifications has no switches of their own
// for these: "pref" says which existing switch controls each one.
export const BLOCK_STEPS = [
  { key: 'start10', pref: '1h', before: 10 * MINUTE, from: 'start' },
  { key: 'end', pref: 'due', before: 0, from: 'end' },
];

// An exam (a block with remind: 'exam'): a day and an hour before it starts. Uses the same switches as deadlines.
export const EXAM_STEPS = [
  { key: '24h', before: 24 * HOUR, from: 'start' },
  { key: '1h', before: HOUR, from: 'start' },
];

// Stop reminding this long after the due time (the end, for a block).
export const GRACE = 6 * HOUR;

/** The reminder steps that apply to this event. A quiet event (a lecture) has none. */
export function stepsFor(event) {
  if (event.quiet) return [];
  if (event.remind === 'exam') return EXAM_STEPS;
  return event.isBlock ? BLOCK_STEPS : REMINDER_STEPS;
}

/** One key per event AND its times, so moving a deadline, a start or an end restarts its reminders. */
export function reminderKey(event) {
  return `${event.id}|${event.start.getTime()}${event.isBlock ? `|${event.end.getTime()}` : ''}`;
}

/** When a step is due, in ms. */
export function stepTime(event, step) {
  return (step.from === 'end' ? event.end : event.start).getTime() - step.before;
}

/** The steps whose time has already come. */
export function reachedSteps(event, now) {
  return stepsFor(event).filter((s) => now >= stepTime(event, s));
}

function browserNotifier(title, body, onClick) {
  if (typeof Notification === 'undefined' || Notification.permission === 'denied') return;
  const fire = () => {
    const n = new Notification(title, { body });
    n.onclick = onClick;
  };
  if (Notification.permission === 'granted') fire();
  else Notification.requestPermission().then((p) => p === 'granted' && fire());
}

export class ReminderService {
  /** @param {object} ctx  @param {{notifier?: Function, intervalMs?: number}} [opts] */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.notifier = opts.notifier ?? browserNotifier;
    this.intervalMs = opts.intervalMs ?? 30000;
    this._timer = null;
  }

  start() {
    this.stop();
    this.tick();
    this._timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  tick(now = Date.now()) {
    const { store, deadlines } = this.ctx;
    const log = (store.meta.reminders ??= {});
    const live = new Set();
    let changed = false;

    for (const event of deadlines.events()) {
      if (event.quiet) continue; // never reminded, so not kept in the log either
      const key = reminderKey(event);
      live.add(key);
      if (event.done) continue;

      const reached = reachedSteps(event, now);
      if (!log[key]) {
        // First time we see this deadline: don't announce steps already behind us.
        log[key] = Object.fromEntries(reached.map((s) => [s.key, true]));
        changed = true;
        continue;
      }
      const fresh = reached.filter((s) => !log[key][s.key]);
      if (!fresh.length) continue;
      for (const s of fresh) log[key][s.key] = true;
      changed = true;
      if (now - event.dueAt.getTime() <= GRACE && this._wanted(fresh)) this._notify(event, now);
    }

    for (const key of Object.keys(log)) {
      if (!live.has(key)) { delete log[key]; changed = true; }
    }
    if (changed) store.touchMeta();
  }

  /** Whether the user wants a notification for any of these steps (Settings › Notifications). */
  _wanted(steps) {
    const prefs = this.ctx.settings?.get('reminders');
    if (!prefs) return true;
    return prefs.enabled && steps.some((s) => prefs[s.pref ?? s.key] !== false);
  }

  _notify(event, now) {
    const where = event.context ? `${event.context}\n` : '';
    const body = `${where}${NextEventLabel.text(event, now)}`;
    this.notifier(event.title || 'Untitled', body, () => {
      window.api?.focusWindow?.();
      if (!event.ref) return;
      this.ctx.selection.select(event.ref.type, event.ref.id);
      this.ctx.bus.emit('reveal', event.ref);
    });
  }
}
