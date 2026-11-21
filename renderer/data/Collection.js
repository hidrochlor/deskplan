import { uid } from '../core/util.js';

// A named set of one kind of Entity. Every change announces itself on the bus:
//   'data:changed'  { collection, type: 'add' | 'update' | 'remove', id }
export class Collection {
  constructor(name, Model, bus) {
    this.name = name;
    this.Model = Model;
    this.bus = bus;
    this._map = new Map();
  }

  all() { return [...this._map.values()]; }
  get(id) { return this._map.get(id) ?? null; }

  add(data) {
    const entity = this.Model.create(data);
    this._map.set(entity.id, entity);
    this._announce('add', entity.id);
    return entity;
  }

  update(id, patch) {
    const entity = this._map.get(id);
    if (!entity) return null;
    Object.assign(entity, patch, { updatedAt: new Date().toISOString() });
    this._announce('update', id);
    return entity;
  }

  remove(id) {
    if (!this._map.delete(id)) return false;
    this._announce('remove', id);
    return true;
  }

  /** Replace everything from saved rows (no announcements). */
  load(rows) {
    this._map.clear();
    for (const row of rows || []) {
      const entity = new this.Model(row);
      if (!entity.id) entity.id = uid();
      this._map.set(entity.id, entity);
    }
  }

  toJSON() { return this.all().map((e) => e.toJSON()); }

  _announce(type, id) {
    this.bus.emit('data:changed', { collection: this.name, type, id });
  }
}
