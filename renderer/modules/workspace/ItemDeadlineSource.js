import { CalendarEvent, CalendarSource } from '../../services/CalendarSource.js';
import { ItemTree } from './ItemTree.js';
import { seriesOf } from './Repeats.js';

// Feeds every item that has a deadline (at any folder depth) to the calendar and the top bar.
// An item with a start as well is a time block: the event runs from start to deadline.
// A step (a task inside an assignment) names its assignment as its group, so the agenda can fold a day's steps.
// A repeating task also shows the copies still to come (half a year ahead): not made yet, so a click selects its
// latest copy, whose panel shows the whole series.
export class ItemDeadlineSource extends CalendarSource {
  constructor(store) {
    super('items');
    this.store = store;
  }

  events() {
    const items = this.store.collection('items');
    const tree = new ItemTree(items);
    return items.all()
      .filter((item) => item.deadlineDate)
      .map((item) => new CalendarEvent({
        id: `item:${item.id}`,
        title: item.title || 'Untitled',
        context: tree.path(item.id).map((f) => f.title || 'Untitled').join(' › '),
        start: item.isBlock ? item.startDate : item.deadlineDate,
        end: item.isBlock ? item.deadlineDate : null,
        kind: item.kindInfo.label,
        color: item.kindInfo.color,
        done: item.isDone,
        ref: { type: 'item', id: item.id },
        group: this.groupOf(item, items, tree),
      }))
      .concat(this.coming(items.all(), tree));
  }

  groupOf(item, items, tree) {
    if (!tree.rules.isStep(item)) return null;
    const assignment = items.get(item.parentId);
    return { id: assignment.id, title: assignment.title || 'Untitled' };
  }

  coming(all, tree) {
    const now = Date.now();
    const horizon = now + 183 * 24 * 3600 * 1000;
    const events = [];
    for (const series of seriesOf(all.filter((i) => i.kind === 'task'), now)) {
      if (series.ended(now)) continue;
      const { latest } = series;
      series.upcoming({ max: 400, horizon }).forEach((c, n) => events.push(new CalendarEvent({
        id: `item:${latest.id}:next${n + 1}`,
        title: latest.title || 'Untitled',
        context: tree.path(latest.id).map((f) => f.title || 'Untitled').join(' › '),
        start: new Date(c.start ?? c.deadline),
        end: c.start ? new Date(c.deadline) : null,
        kind: latest.kindInfo.label,
        color: latest.kindInfo.color,
        done: false,
        ref: { type: 'item', id: latest.id },
        quiet: true, // its reminders come with the copy itself, made once the one before has passed
      })));
    }
    return events;
  }
}
