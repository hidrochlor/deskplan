// Is this PC's current network one it is safe to receive files on?
//
// Windows sorts every network into Private (home, your own hotspot), Public (cafés, schools, anywhere
// unfamiliar) or Domain (work). On a Public network other people can see this PC, and Windows blocks
// incoming connections anyway, so Settings warns about it. This class only reads that label; it never
// changes it. On other systems, or if the lookup fails, the answer is "unknown" and nothing is warned.
const { execFile } = require('child_process');
const os = require('os');
const { LanAddress } = require('./LanAddress');

const SCRIPT = 'Get-NetConnectionProfile | ForEach-Object { [pscustomobject]@{ alias = $_.InterfaceAlias; category = $_.NetworkCategory.ToString() } } | ConvertTo-Json -Compress';

class NetworkProfile {
  /**
   * @param {{interfaces?: () => object, run?: () => Promise<string>, platform?: string}} [o]
   *   run/interfaces/platform are replaced in tests
   */
  constructor({ interfaces = os.networkInterfaces, run = NetworkProfile.runPowerShell, platform = process.platform } = {}) {
    Object.assign(this, { interfaces, run, platform });
  }

  /** @returns {Promise<{interfaceName: string|null, address: string|null, category: 'Private'|'Public'|'Domain'|'Unknown'}>} */
  async current() {
    const lan = LanAddress.pickInterface(this.interfaces());
    const unknown = { interfaceName: lan?.name ?? null, address: lan?.address ?? null, category: 'Unknown' };
    if (this.platform !== 'win32' || !lan) return unknown;
    try {
      const profile = NetworkProfile.parse(await this.run()).find((p) => p.alias === lan.name);
      return profile ? { ...unknown, category: profile.category } : unknown;
    } catch {
      return unknown; // PowerShell missing or blocked: do not guess
    }
  }

  /** PowerShell prints one object for a single network and a list for several. */
  static parse(json) {
    const data = JSON.parse(json);
    return (Array.isArray(data) ? data : [data])
      .filter((p) => p && typeof p.alias === 'string')
      .map((p) => ({ alias: p.alias, category: /^(Private|Public)$/.test(p.category) ? p.category : /^Domain/.test(p.category) ? 'Domain' : 'Unknown' }));
  }

  static runPowerShell() {
    return new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
        { timeout: 8000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
  }
}

module.exports = { NetworkProfile };
