// Tiny publish/subscribe hub. Components talk through it instead of calling each other.
// A handler that throws is logged and skipped, so one broken part can't freeze the rest.
export class EventBus {
  constructor() {
    this._handlers = new Map();
  }

  /** Subscribe. Returns a function that unsubscribes. */
  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this._handlers.get(event)?.delete(fn);
  }

  emit(event, payload) {
    for (const fn of [...(this._handlers.get(event) || [])]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] handler for "${event}" failed`, err);
      }
    }
  }
}
