# DeskPlan

Lightweight desktop planner. One canvas of folders (a course, a project, a job); inside each:
assignments, tasks, readings, notes, files and photos. Anything with a deadline shows on the
calendar and the top-bar countdown. Electron, plain JavaScript, no UI framework.

## Run (Windows, PowerShell, not WSL)

Needs Node.js 18+.

    npm install
    npm start

`npm run dev` opens the dev tools too. `npm test` runs the logic tests.

## Your data

Everything lives in one folder, `%APPDATA%\deskplan\` (Settings › Data › Open data folder):

- `deskplan-data.json`: folders, notes, tasks, deadlines and settings (plus a `.bak` copy of the previous save).
- `files\`: DeskPlan's own copies of the files and photos you add, so moving or deleting the originals breaks nothing.
  Only a small reference (name, size, location) goes into the `.json`, never the file itself, so saving stays fast.
  Files over 10 MB ask before being copied. Deleting a file in DeskPlan (or the folder it's in) deletes its copy too.

**Backing up means copying the whole `%APPDATA%\deskplan\` folder**, not only the `.json` file;
the `.json` alone has no attached files. (Settings › Data › Export a backup saves the `.json` part only.)
To restore, close DeskPlan and put the folder back.

## Files from your phone (DeskPlan Companion)

Off until you switch it on (top-bar phone icon, or Settings › Phones). Then: Settings › Phones › Show code, scan it with the
Companion app. DeskPlan then pops up a message ("<phone> wants to connect") asking you to **Approve** it, and sends a desktop
notification if DeskPlan is not in front. Until you approve, the phone can send nothing. (Closing the message with × decides later:
approve or refuse in the top-bar phone icon or in Settings › Phones.) Files you share from the phone arrive on the **Received files** page (Ctrl+3) and are stored in
`%APPDATA%\deskplan\Received files\` (older versions used `inbox\`; it is renamed at the next start).

**Only documents, images and links are accepted** (PDF, Word, text, slides, spreadsheets, photos, and `.url` web links). Programs, installers, scripts, archives and anything else (`.exe`, `.apk`, `.zip`, `.html`...) are refused by DeskPlan before they are even uploaded. The phone only works on the same network as this PC; away from it, it keeps things queued.

The phone can also send a file **straight into one of your folders** (for example an image into CSC101): it lists your folders and lets
you pick one. The file then appears in that folder like any file you dropped there, and a short message confirms it. If that folder was
deleted in the meantime, the file goes to Received files instead, so nothing is lost.

The top-bar phone icon shows how things stand. Its dot: **grey** receiving is off, **blue** receiving is on but no phone has been seen in the
last 10 minutes (or none is paired), **green** a phone was seen in the last 10 minutes, **amber** a phone is waiting for your approval.
A phone syncs now and then instead of staying connected, so green means "seen recently". A small amber **!** next to the icon is a
separate warning: Windows calls the current network Public, so other people on it can see this PC.

- **Windows Firewall:** the first time you switch receiving on, Windows may ask. Allow DeskPlan on **Private networks only**.
- **Home Wi-Fi** is the main target. **School or shared Wi-Fi** may block phones from reaching the PC, and Windows treats unfamiliar
  networks as Public. DeskPlan does not try to get around that: the phone keeps the file queued until the PC can be reached.
- **Phone hotspot** works anywhere: join the laptop to the phone's hotspot (set that network to Private in Windows).
- The pairing code is a password. Show it only to your own phone, and approve only phones you recognise. A code that nobody scans
  stops working after 10 minutes. Revoke a phone any time in Settings › Phones.
- Everything stays on your own devices: no cloud, no account. Traffic is encrypted, and the phone only talks to the certificate
  it was paired with.
- The PC side is in `main/receiver/`, the screens in `renderer/modules/receivedfiles/`. Delete the `ReceivedFilesModule` line in `app.js` to remove
  the screens (files already received stay in the Received files folder).
- **Docs:** there are three. `docs/protocol.md` is the contract with the phone app (only rules that stay true: the wire rules and limits).
  `docs/CHANGES.md` is what to do next on both sides (steps, the phone's build guide, open questions); it never holds wire rules.
  `docs/DESIGN.md` is the look the phone app copies. Keep them in step with the code, and copy all three to the phone project
  (or back from it, when the phone side changed them last). The phone project also has `docs/IOS_PORT.md`, the plan for an
  iPhone version; it is phone-only and not copied here.

## Screen

- Left: Home (the canvas) and Calendar.
- Middle: Home shows your folders. Click one to open it; the trail at the top (`Home › Python Basics`) takes you back.
  Inside a folder, sections show sub-folders, To do (assignments, tasks, readings), Notes, and Files.
  Add with the bar at the top, the Files button, or by dropping files from Explorer onto the canvas.
  A note opens full size for writing.
- Right: details of whatever is selected (× to close, Ctrl+J to toggle).
- Top right: next deadline, two rows: `GPA calculator · Python Basics`, then `Oct 28, 23:59 · 4h 12m left`. Click it to jump to it.

Deadlines can be set on anything except files (quick-add bar, or the right panel). They appear on the calendar and the top bar automatically, and trigger desktop notifications at 24 h, 1 h and at the due time.

Shortcuts: Ctrl+1/2 switch page, Ctrl+N add something, Ctrl+J toggle right panel.

## How it is built

Every part is a small class. Features are plugins.

    renderer/
      core/       EventBus, Registry, Component (base UI class), dates, dom helper
      data/       Entity, Collection, Store (saving, versioning), storage adapters
      services/   Selection, DeadlineService, ReminderService, CalendarSource
      shell/      TopBar, Sidebar, CanvasHost, DetailPanel (know nothing about tasks or notes)
      modules/
        workspace/  Item (kinds), ItemTree (folders), WorkspaceView (canvas), NotePage,
                    ItemEditor (right panel), Attachments (files), ItemDeadlineSource, WorkspaceModule
        calendar/   CalendarView, CalendarModule
      app.js      the list of modules + wiring

**Settings** (gear at the bottom of the icon bar, or Ctrl+,): pages come from `modules/settings/`. Any module can add its own page with `registry.register('settingsSection', { id, label, icon, create })`. Values live in the data file under `meta.settings`; `services/Display.js` applies the look.
**Add a kind of item** (e.g. "Lab"): one line in `ITEM_KINDS` in `modules/workspace/Item.js`.
**Remove a feature:** delete its line in the `MODULES` list in `app.js`. Its saved data stays in the file and returns if you add the line back.
**Add a feature:** make `modules/<name>/` with a class extending `FeatureModule`, add one line to `MODULES`. A module can register:
- a page (`registry.register('view', ...)`)
- a right-panel editor (`'editor'`)
- dated things for the calendar and top bar (`'calendarSource'`, extend `CalendarSource`)

**Compatibility:** new fields get defaults when old data loads; unknown fields are kept; data from modules that aren't installed is preserved; `MIGRATIONS` in `data/Store.js` handles shape changes.

**Debugging:** every component cleans up after itself on `unmount()`; one failing handler, source, view or module is logged and skipped instead of crashing the app. In `npm run dev`, type `deskplan` in the console to inspect the store, registry and services.
