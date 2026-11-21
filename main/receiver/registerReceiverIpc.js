// Connects the receiver to the page: IPC handlers for the preload bridge, and events pushed to the window.
// Kept out of main.js so main.js only has to create the controller and call this once.
// The page can only do what is listed here; every argument is checked before it reaches the controller.
const text = (v) => (typeof v === 'string' ? v : '');

/**
 * @param {{ipcMain: object, shell: object, controller: ReceiverController, getWindow: () => object|null,
 *          gateway?: RendererItemGateway}} o  gateway = the one the controller sends task changes through
 */
function registerReceiverIpc({ ipcMain, shell, controller, getWindow, gateway = null }) {
  const push = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  controller.on('received', (record) => push('receiver:received', record));
  controller.on('devices', () => push('receiver:devices', controller.status()));

  ipcMain.handle('receiver:status', () => controller.status());
  ipcMain.handle('receiver:set-enabled', (_e, on) => controller.setEnabled(on === true));
  ipcMain.handle('receiver:start-pairing', () => controller.startPairing());
  ipcMain.handle('receiver:approve', (_e, id) => controller.approve(text(id)));
  ipcMain.handle('receiver:rename', (_e, id, name) => controller.renameDevice(text(id), text(name)));
  ipcMain.handle('receiver:revoke', (_e, id) => controller.revoke(text(id)));
  ipcMain.handle('receiver:pending-received', () => controller.pendingReceived());
  ipcMain.handle('receiver:acknowledge', (_e, ids) => controller.acknowledge((Array.isArray(ids) ? ids : []).map(text)));
  ipcMain.handle('receiver:open-file', (_e, storedAs) => shell.openPath(controller.resolveReceivedFile(storedAs)));
  ipcMain.handle('receiver:reveal-file', (_e, storedAs) => shell.showItemInFolder(controller.resolveReceivedFile(storedAs)));
  // The page's answer to a task change the phone sent (see RendererItemGateway).
  ipcMain.handle('receiver:item-reply', (_e, msg) => gateway?.reply(text(msg?.requestId), msg?.reply));
  ipcMain.handle('receiver:attach-file', (_e, storedAs, uploadId) => controller.attachReceivedFile(text(storedAs), text(uploadId)));
  ipcMain.handle('receiver:delete-file', (_e, storedAs) => controller.deleteReceivedFile(storedAs));
  ipcMain.handle('receiver:open-folder', () => shell.openPath(controller.receivedDir));
}

module.exports = { registerReceiverIpc };
