// A feature = one folder in modules/ + one line in app.js.
// install() registers the feature's data, views, editors and calendar sources.
// To remove a feature: delete its line in app.js (its saved data stays in the file, untouched).
export class FeatureModule {
  constructor(id) {
    this.id = id;
  }

  /** @param {object} ctx  { bus, registry, store, selection, deadlines } */
  install(ctx) {
    throw new Error(`FeatureModule "${this.id}" must implement install(ctx)`);
  }
}
