// Connects the calendar feeds to the page (see FeedController). Same idea as registerReceiverIpc:
// the page can only do what is listed here, and every argument is checked first.
const text = (v) => (typeof v === 'string' ? v : '');

/** @param {{ipcMain: object, controller: import('./FeedController').FeedController}} o */
function registerCalendarIpc({ ipcMain, controller }) {
  ipcMain.handle('feeds:list', () => controller.list());
  ipcMain.handle('feeds:add', (_e, url) => controller.add(text(url).slice(0, 4000)));
  ipcMain.handle('feeds:refresh', (_e, id) => controller.refresh(text(id)));
  ipcMain.handle('feeds:remove', (_e, id) => controller.remove(text(id)));
}

module.exports = { registerCalendarIpc };
