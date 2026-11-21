import { uid } from '../core/util.js';

// Base for anything saved (tasks, notes, ...).
// Subclasses only declare their default fields. Fields found in old or newer
// save files that the class doesn't know about are kept, never dropped.
export class Entity {
  static defaults() { return {}; }

  static create(data = {}) {
    const now = new Date().toISOString();
    return new this({ id: uid(), createdAt: now, updatedAt: now, ...data });
  }

  constructor(data = {}) {
    Object.assign(this, this.constructor.defaults(), data);
  }

  toJSON() { return { ...this }; }
}
