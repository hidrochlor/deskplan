import { EventBus } from './core/EventBus.js';
import { Registry } from './core/Registry.js';
import { Store } from './data/Store.js';
import { ElectronStorage, MemoryStorage } from './data/storage.js';
import { SelectionService } from './services/Selection.js';
import { DeadlineService } from './services/DeadlineService.js';
import { ReminderService } from './services/ReminderService.js';
import { SettingsService } from './services/SettingsService.js';
import { Display } from './services/Display.js';
import { TopBar } from './shell/TopBar.js';
import { Sidebar } from './shell/Sidebar.js';
import { CanvasHost } from './shell/CanvasHost.js';
import { DetailPanel } from './shell/DetailPanel.js';
import { SettingsModal } from './shell/SettingsModal.js';
import { Tooltip } from './core/Tooltip.js';
import { ToastHost } from './shell/ToastHost.js';

import { WorkspaceModule } from './modules/workspace/WorkspaceModule.js';
import { CalendarModule } from './modules/calendar/CalendarModule.js';
import { SettingsModule } from './modules/settings/SettingsModule.js';
import { ReceivedFilesModule } from './modules/receivedfiles/ReceivedFilesModule.js';
import { PhoneSyncModule } from './modules/phonesync/PhoneSyncModule.js';
import { FeedsModule } from './modules/feeds/FeedsModule.js';

// ── Features ─────────────────────────────────────────────────────────────
// One line per feature. Delete a line to remove the feature; add one to add it.
const MODULES = [
  new WorkspaceModule(),   // Home: folders with assignments, notes, tasks, files
  new CalendarModule(),    // month view of every deadline
  new ReceivedFilesModule(), // files from the phone: Received files page, top-bar phone icon, Settings › Phones
  new PhoneSyncModule(),   // tasks created, changed or deleted on the phone
  new FeedsModule(),       // FH timetable + Moodle calendar: lectures, exams, due dates; Settings › Data › Calendar feeds
  new SettingsModule(),    // the pages of the Settings window
];

// ── Wiring ───────────────────────────────────────────────────────────────
const bus = new EventBus();
const registry = new Registry();
const storage = window.api ? new ElectronStorage() : new MemoryStorage(); // plain browser = no saving
const store = new Store({ bus, storage });

const ctx = { bus, registry, store };
ctx.selection = new SelectionService(ctx);
ctx.settings = new SettingsService(ctx);
ctx.deadlines = new DeadlineService(ctx);
ctx.reminders = new ReminderService(ctx);

for (const module of MODULES) {
  try {
    module.install(ctx);
  } catch (err) {
    console.error(`[module "${module.id}"] install failed, skipping it`, err);
  }
}

await store.load();
new Display(ctx).start(); // theme, accent, font, size, clock: before anything draws
bus.emit('app:ready');    // saved data is loaded: modules that need it can start (e.g. receiving files from the phone)

// ── Screen ───────────────────────────────────────────────────────────────
const panelHost = document.getElementById('panel');
new SettingsModal(ctx).mount(document.body);
new Tooltip().start(); // app-styled hover tips for anything with data-tip
new ToastHost(ctx).mount(document.body); // small pop-ups: bus.emit('toast:show', { id, title, text, actions })
new TopBar(ctx).mount(document.getElementById('topbar'));
new Sidebar(ctx).mount(document.getElementById('sidebar'));
new CanvasHost(ctx).mount(document.getElementById('canvas'));
new DetailPanel(ctx, panelHost).mount(panelHost);

ctx.reminders.start();

// ── Shortcuts ────────────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const views = registry.list('view');
  if (/^[1-9]$/.test(e.key) && views[Number(e.key) - 1]) {
    e.preventDefault();
    bus.emit('view:open', { id: views[Number(e.key) - 1].id });
  } else if (e.key.toLowerCase() === 'j') {
    e.preventDefault();
    bus.emit('panel:toggle');
  } else if (e.key.toLowerCase() === 'n') {
    e.preventDefault();
    bus.emit('new');
  } else if (e.key === ',') {
    e.preventDefault();
    bus.emit('settings:open');
  }
});

window.addEventListener('beforeunload', () => {
  bus.emit('app:before-quit'); // lets open editors hand over unsaved typing first
  store.flushSync();
});

window.deskplan = ctx; // handy in the dev console: deskplan.store, deskplan.deadlines.events() ...
