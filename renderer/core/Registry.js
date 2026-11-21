// A plug-in list. Feature modules register what they offer (views, editors,
// calendar sources); the shell reads from here and never imports a feature directly.
//
// kinds in use:
//   'view'           sidebar page   { id, label, icon, create(ctx) -> Component }
//   'editor'         right panel    { id (= entity type), create(ctx, entityId) -> Component }
//   'calendarSource' deadline feed  CalendarSource instance
//   'shortcuts'      listed in Settings › About  { id, label, keys: [[keys, what it does]] }
//   'settingsSection' Settings page { id, label, icon, create(ctx) -> Component }
//   'phoneCalendar'  read-only events for the phone's calendar  { id, events(from: Date, to: Date) -> [{ id, kind, title, context, start, end }] }
//   'settingsData'   extra rows on Settings › Data  { id, create(ctx) -> { rows(section) -> elements, mount?(section), unmount?() } }
//   'topBarItem'     small control in the top bar  { id, create(ctx) -> Component }
//   'creator'        add from other pages  { id, kinds: [{id,label}], places() -> [{id,label}],
//                                            problem({ kind, placeId, due, start }) -> text or null,
//                                            create({ kind, title, due: Date, start?: Date, placeId }) }
//   'itemRules'      where tasks / assignments may live  { id, rulesFor(items) -> ItemRules }
//   'noteFormat'     a note's text as plain text and back { id, toPlainText(doc) -> text, fromPlainText(text) -> doc }
export class Registry {
  constructor() {
    this._kinds = new Map();
  }

  register(kind, spec, order = 100) {
    if (!spec || !spec.id) throw new Error(`Registry: a "${kind}" needs an id`);
    if (!this._kinds.has(kind)) this._kinds.set(kind, new Map());
    this._kinds.get(kind).set(spec.id, { spec, order });
    return spec;
  }

  unregister(kind, id) {
    this._kinds.get(kind)?.delete(id);
  }

  get(kind, id) {
    return this._kinds.get(kind)?.get(id)?.spec ?? null;
  }

  /** All specs of a kind, lowest order first. */
  list(kind) {
    const entries = [...(this._kinds.get(kind)?.values() ?? [])];
    return entries.sort((a, b) => a.order - b.order).map((e) => e.spec);
  }
}
