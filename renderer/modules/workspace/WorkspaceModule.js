import { FeatureModule } from '../../core/FeatureModule.js';
import { Item } from './Item.js';
import { ItemTree } from './ItemTree.js';
import { Attachments } from './Attachments.js';
import { ItemDeadlineSource } from './ItemDeadlineSource.js';
import { WorkspaceView } from './WorkspaceView.js';
import { ItemEditor } from './ItemEditor.js';
import { Repeats } from './Repeats.js';
import { EDITOR_SHORTCUTS } from './editor/shortcuts.js';
import { fromPlainText, toPlainText } from './editor/NoteFormat.js';

// The Home canvas: folders holding assignments, tasks, readings, notes and files.
// Anything in it with a deadline feeds the calendar, the top bar and reminders.
export class WorkspaceModule extends FeatureModule {
  constructor({ attachments = new Attachments() } = {}) {
    super('workspace');
    this.attachments = attachments;
  }

  install(ctx) {
    const { store, registry, bus } = ctx;
    store.define('items', Item);
    // A repeating item makes its next copy when it is ticked off. It starts once the saved items are loaded.
    const repeats = new Repeats({ store, bus });
    bus.on('app:ready', () => repeats.start());
    registry.register('view', { id: 'home', label: 'Home', icon: 'home', create: (c) => new WorkspaceView(c, this.attachments) }, 10);
    registry.register('editor', { id: 'item', create: (c, id) => new ItemEditor(c, id, this.attachments) });
    registry.register('calendarSource', new ItemDeadlineSource(store));
    // Lets other modules (the phone sync) ask where things may live, without importing from here.
    registry.register('itemRules', { id: 'items', rulesFor: (items) => new ItemTree(items).rules });
    // ...and how a note's formatted text becomes plain text and back (notes sync with the phone as Tiptap JSON).
    registry.register('noteFormat', { id: 'notes', toPlainText, fromPlainText });
    registry.register('shortcuts', { id: 'editor', label: 'Note editor', keys: EDITOR_SHORTCUTS }, 20);

    // Lets other pages (the calendar) add things here without knowing about items or folders.
    registry.register('creator', {
      id: 'workspace',
      kinds: [{ id: 'assignment', label: 'Assignment' }, { id: 'task', label: 'Task' }],
      places: () => [
        { id: '', label: 'Home' },
        ...new ItemTree(store.collection('items')).folderOptions({ openOnly: true }),
      ],
      // Why this can not be created, or null. (An assignment needs a folder; the calendar form shows the message.)
      // (`start` is for a task: it is a time block from start to due, and both are needed.)
      problem: ({ kind, placeId, due, start = null }) => new ItemTree(store.collection('items')).rules
        .problem({ kind, parentId: placeId || null, deadline: due ? due.toISOString() : null, start: start ? start.toISOString() : null, creating: true }),
      create: ({ kind, title, due, start = null, placeId }) => {
        const item = store.collection('items').add({
          kind, title, parentId: placeId || null, deadline: due.toISOString(), start: start ? start.toISOString() : null,
        });
        ctx.selection.select('item', item.id);
        return item;
      },
    });

    // 'reveal' { type, id }: take the canvas to where an item lives and select it.
    // Sent by the top bar and the item panel; anything else can send it too.
    bus.on('reveal', (ref) => {
      if (ref?.type !== 'item') return;
      const items = store.collection('items');
      const item = items.get(ref.id);
      if (!item) return;
      const tree = new ItemTree(items);
      // Folders and notes open themselves. An assignment is shown as a row in its folder, unless asked to open its steps.
      const opensItself = item.isNote || (tree.isFolder(item) && item.kind !== 'assignment') || (ref.inside && item.kind === 'assignment');
      const target = opensItself ? item.id : tree.parentOf(item);
      store.meta.ui = { ...(store.meta.ui ?? {}), open: target };
      bus.emit('view:open', { id: 'home' });       // mounts Home if needed (it reads meta.ui.open)
      bus.emit('workspace:open', { id: target });  // moves it if it was already showing
      ctx.selection.select('item', item.id);
    });
  }
}
