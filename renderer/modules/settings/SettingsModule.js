import { FeatureModule } from '../../core/FeatureModule.js';
import { AppearanceSection, DateTimeSection, NotificationsSection, DataSection, AboutSection } from './sections.js';

// The built-in pages of the Settings window. Other modules can register more
// 'settingsSection' entries; the order number decides where they appear.
export class SettingsModule extends FeatureModule {
  constructor() { super('settings'); }

  install({ registry }) {
    const add = (id, label, icon, Section, order) =>
      registry.register('settingsSection', { id, label, icon, create: (ctx) => new Section(ctx) }, order);
    add('appearance', 'Appearance', 'palette', AppearanceSection, 10);
    add('datetime', 'Date & time', 'clock', DateTimeSection, 20);
    add('notifications', 'Notifications', 'bell', NotificationsSection, 30);
    add('data', 'Data', 'database', DataSection, 80);
    add('about', 'About', 'info', AboutSection, 90);
  }
}
