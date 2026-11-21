import { FeatureModule } from '../../core/FeatureModule.js';
import { ItemSync } from './ItemSync.js';
import { FolderDestinations } from './FolderDestinations.js';
import { PhoneRequests } from './PhoneRequests.js';
import { SyncLog } from './SyncLog.js';
import { ItemPull } from './ItemPull.js';
import { PhoneItemMapper } from './PhoneItemMapper.js';
import { CalendarPull } from './CalendarPull.js';

// What the phone can do to the things in DeskPlan's folders: create, change and delete tasks, and
// send files straight into a folder, and ask what changed on the PC (the pull). The receiver (main process) forwards each request here because
// all of that data lives in this page. Without this module the receiver answers 503 to task requests
// and only offers Received files as a destination; plain file receiving is not affected.
// Needs the workspace module's "items" data to do anything.
export class PhoneSyncModule extends FeatureModule {
  /** @param {{api?: object|null}} [o]  api = window.api.receiver */
  constructor({ api = globalThis.window?.api?.receiver ?? null } = {}) {
    super('phonesync');
    this.api = api;
  }

  install({ bus, store, registry }) {
    if (!this.api?.onItemRequest) return;
    const log = new SyncLog({ store, bus }); // remembers deleted tasks for the pull
    // Where things may live is the workspace's rule; it offers it through the registry ('itemRules'), looked up when asked.
    const rulesFor = (items) => registry.list('itemRules')[0].rulesFor(items);
    // A note's plain text is the workspace's format too ('noteFormat').
    const noteText = {
      toPlainText: (doc) => registry.list('noteFormat')[0].toPlainText(doc),
      fromPlainText: (text) => registry.list('noteFormat')[0].fromPlainText(text),
    };
    const mapper = new PhoneItemMapper({ noteText });
    const requests = new PhoneRequests({
      sync: new ItemSync({ store, rulesFor, mapper }), registry, pull: new ItemPull({ store, log, rulesFor, mapper }),
      calendar: new CalendarPull({ registry }), // lectures and exams: from any 'phoneCalendar' provider (the feeds module)
    });
    // The Received files module asks every 'destination' for a received file that was sent to one of them.
    registry.register('destination', new FolderDestinations({ store, bus, attach: (storedAs, uploadId) => this.api.attachFile(storedAs, uploadId) }));
    // Waits for the saved data to load first; a request that comes earlier gets 503 and the phone retries.
    bus.on('app:ready', () => {
      log.start(); // after the data is loaded, so it knows what exists now
      this.api.onItemRequest((request) => requests.handle(request));
    });
  }
}
