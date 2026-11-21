import { formatSpan } from '../../core/dates.js';

/**
 * How to show a phone that may not have told us its name. Older phone builds do not send one.
 * @param {{name?: string, claimedAt?: number|null}} device
 * @param {(d: Date) => string} formatDateTime  passed in so this file stays free of imports
 */
export function deviceLabel(device, formatDateTime) {
  if (device.name) return device.name;
  return device.claimedAt ? `Unnamed phone (paired ${formatDateTime(new Date(device.claimedAt))})` : 'Unnamed phone';
}

// What the phone icon in the top bar should say, decided from the receiver's status.
// Pure function (no screen), so it is easy to test. It returns { level, label, warning }.
//
// level is the connection, shown as the colour of the dot:
//   off        receiving is switched off, or not available (plain browser)
//   attention  a phone is waiting for the user to approve it
//   ok         receiving is on and an approved phone was seen in the last 10 minutes
//   ready      receiving is on, but no approved phone has been seen lately (or none is paired yet)
// A phone does not keep a connection open, it syncs now and then, so "connected" means "seen recently".
//
// warning is separate and does not change the colour: it is set while receiving is on and Windows calls the
// current network Public (shared Wi-Fi: other people can see this PC). The screen shows it as a small badge.
export const RECENT_MS = 10 * 60 * 1000;

const ago = (ms) => (ms < 60 * 1000 ? 'just now' : `${formatSpan(ms)} ago`);

/** @param {object|null} status  from the receiver  @param {number} [now]  replaced in tests */
export function phoneState(status, now = Date.now()) {
  if (!status) return { level: 'off', label: 'Phone receiving is not available', warning: null };
  if (!status.enabled) return { level: 'off', label: 'Receiving is off', warning: null };

  const warning = status.network?.category === 'Public' ? 'Public network: other people on it can see this PC' : null;
  const devices = status.devices ?? [];

  const waiting = devices.filter((d) => !d.approved).length;
  if (waiting) {
    return { level: 'attention', label: waiting === 1 ? 'A phone is waiting for your approval' : `${waiting} phones are waiting for your approval`, warning };
  }

  const approved = devices.filter((d) => d.approved);
  if (!approved.length) return { level: 'ready', label: 'Receiving is on · no phone paired yet', warning };

  const lastSeen = Math.max(0, ...approved.map((d) => d.lastSeen ?? 0));
  if (lastSeen && now - lastSeen <= RECENT_MS) return { level: 'ok', label: `Connected · last seen ${ago(now - lastSeen)}`, warning };
  return { level: 'ready', label: lastSeen ? `Paired · not seen for ${formatSpan(now - lastSeen)}` : 'Paired · waiting for the phone', warning };
}
