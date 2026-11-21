// Remembers which thing is selected ({ type, id }). The right panel shows an
// editor for it. Emits:
//   'selection:changed'  when the selected thing changes
//   'selection:picked'   on every select(), even of the thing already selected
//                        (so clicking it again re-opens a closed panel)
export class SelectionService {
  constructor(ctx) {
    this.bus = ctx.bus;
    this.current = null;
    // If the selected thing gets deleted, deselect it.
    this.bus.on('data:changed', (e) => {
      if (e.type === 'remove' && this.current && this.current.id === e.id) this.clear();
    });
  }

  select(type, id) {
    if (!this.is(type, id)) {
      this.current = { type, id };
      this.bus.emit('selection:changed', this.current);
    }
    this.bus.emit('selection:picked', this.current);
  }

  clear() {
    if (!this.current) return;
    this.current = null;
    this.bus.emit('selection:changed', null);
  }

  is(type, id) {
    return !!this.current && this.current.type === type && this.current.id === id;
  }
}
