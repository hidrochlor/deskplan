import { FeatureModule } from '../../core/FeatureModule.js';
import { ReceivedFile } from './ReceivedFile.js';
import { ReceivedFilesView } from './ReceivedFilesView.js';
import { ReceivedFileEditor } from './ReceivedFileEditor.js';
import { ReceivedFilesIntake } from './ReceivedFilesIntake.js';
import { PhoneLink } from './PhoneLink.js';
import { PhoneApprovals } from './PhoneApprovals.js';
import { PhoneStatusButton } from './PhoneStatusButton.js';
import { PhonesSection } from './PhonesSection.js';

// Files from the phone (DeskPlan Companion). The receiver itself runs in the main process (main/receiver/);
// this module is its screen side: the Received files page, a phone icon in the top bar, and Settings › Phones.
// Delete its line in app.js and all three disappear. Received files stay safe in the Received files folder.
export class ReceivedFilesModule extends FeatureModule {
  /** @param {{api?: object|null}} [o]  api = window.api.receiver; null/absent in a plain browser */
  constructor({ api = globalThis.window?.api?.receiver ?? null } = {}) {
    super('receivedFiles');
    this.api = api;
  }

  install(ctx) {
    const { store, registry, bus } = ctx;
    const link = new PhoneLink({ bus, api: this.api });
    store.define('receivedFiles', ReceivedFile);

    registry.register('view', { id: 'receivedFiles', label: 'Received files', icon: 'receivedFiles', create: (c) => new ReceivedFilesView(c, link, this.api) }, 40);
    registry.register('editor', { id: 'receivedFile', create: (c, id) => new ReceivedFileEditor(c, id, this.api) });
    if (!this.api) return; // the rest needs the desktop app

    registry.register('settingsSection', { id: 'phones', label: 'Phones', icon: 'phone', create: (c) => new PhonesSection(c, link, this.api) }, 40);
    registry.register('topBarItem', { id: 'phones', create: (c) => new PhoneStatusButton(c, link) }, 10);

    new PhoneApprovals({ bus, link }); // toast + notification when a new phone asks to connect

    // Starts once the saved data is loaded (the intake adds entries to it).
    const intake = new ReceivedFilesIntake({ store, api: this.api, ReceivedFile, registry });
    bus.on('app:ready', () => {
      link.start().catch((err) => console.error('[received-files] phone status unavailable', err));
      intake.start().catch((err) => console.error('[received-files] could not collect received files', err));
    });
  }
}
