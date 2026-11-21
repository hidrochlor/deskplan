// Picks this PC's address on the home network, for the QR code's "hint" (a first guess for the phone).
// Only a hint: the phone also finds the PC by name, and the address can change.

/** Private ranges that home and school networks use. */
const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

class LanAddress {
  /** @param {ReturnType<typeof import('os').networkInterfaces>} interfaces @returns {string|null} */
  static pick(interfaces) {
    return LanAddress.pickInterface(interfaces)?.address ?? null;
  }

  /** The same choice, with the adapter's name (e.g. "Wi-Fi"), so its Windows network type can be looked up. */
  static pickInterface(interfaces) {
    const found = [];
    for (const [name, list] of Object.entries(interfaces ?? {})) {
      for (const a of list ?? []) {
        if (a.family !== 'IPv4' || a.internal || !isPrivate(a.address)) continue;
        // Virtual adapters (WSL, VPN, Docker, VirtualBox) are rarely the one the phone can reach.
        const virtual = /vethernet|wsl|virtual|vmware|vpn|docker|tailscale|hyper-v/i.test(name);
        found.push({ name, address: a.address, virtual });
      }
    }
    found.sort((a, b) => Number(a.virtual) - Number(b.virtual));
    return found[0] ? { name: found[0].name, address: found[0].address } : null;
  }
}

module.exports = { LanAddress };
