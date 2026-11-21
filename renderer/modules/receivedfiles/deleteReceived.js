// Deletes received files: the stored file first, then its entry. A file that can not be deleted keeps its entry, so
// nothing is left orphaned. Used by the list (several at once) and the side panel (one).
/**
 * @param {{items: object, api: object|null}} o  items = the 'receivedFiles' collection, api = window.api.receiver
 * @param {string[]} ids
 * @returns {Promise<{deleted: string[], failed: string[]}>}
 */
export async function deleteReceived({ items, api }, ids) {
  const deleted = [];
  const failed = [];
  for (const id of ids) {
    const item = items.get(id);
    if (!item) continue;
    try {
      await api?.deleteFile(item.storedAs);
      items.remove(id);
      deleted.push(id);
    } catch (err) {
      console.error('[received-files] could not delete the file', item.storedAs, err);
      failed.push(id);
    }
  }
  return { deleted, failed };
}
