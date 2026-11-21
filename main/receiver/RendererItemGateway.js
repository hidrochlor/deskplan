// Task data lives in the page (renderer), not in the main process. So when the phone sends a task change,
// the receiver asks the page to apply it through this gateway and waits for the answer:
//   request('put', { body })  ->  sends 'receiver:item-request' to the window
//   the page answers via IPC  ->  reply(requestId, { status, body })  ->  the promise resolves
// If the page does not answer in time (still starting, busy) the phone gets 503 and simply retries.
const crypto = require('crypto');

const NOT_READY = { status: 503, body: { error: 'app-not-ready' } };

class RendererItemGateway {
  /** @param {{getWindow: () => object|null, timeoutMs?: number}} o */
  constructor({ getWindow, timeoutMs = 5000 }) {
    this.getWindow = getWindow;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
  }

  /**
   * @param {'put'|'delete'|'destinations'|'destination-exists'|'pull'|'calendar'|'feed-courses'} op
   * @param {{timeoutMs?: number}} [options]  how long to wait for the page (default: the gateway's own)
   * @returns {Promise<{status: number, body: object}>}
   */
  request(op, payload, { timeoutMs = this.timeoutMs } = {}) {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return Promise.resolve(NOT_READY);

    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); resolve(NOT_READY); }, timeoutMs);
      this.pending.set(requestId, (reply) => { clearTimeout(timer); resolve(reply); });
      win.webContents.send('receiver:item-request', { requestId, op, payload });
    });
  }

  /** Called with the page's answer. An unknown id (already timed out) or a malformed answer is ignored. */
  reply(requestId, reply) {
    const done = this.pending.get(requestId);
    const ok = reply && Number.isInteger(reply.status) && reply.status >= 200 && reply.status < 600
      && reply.body && typeof reply.body === 'object';
    if (!done || !ok) return;
    this.pending.delete(requestId);
    done({ status: reply.status, body: reply.body });
  }
}

module.exports = { RendererItemGateway };
