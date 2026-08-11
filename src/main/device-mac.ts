import os from 'os'

const ZERO_MAC = '00:00:00:00:00:00'
const VIRTUAL_IFACE_RE =
  /^(lo|loopback|awdl|llw|utun|bridge|vmenet|vmnet|vboxnet|docker|veth|br-|ap|p2p|bluetooth)/i

function isIpv4Family(family: string | number): boolean {
  return family === 'IPv4' || family === 4 || String(family) === '4'
}

function isUsableMac(mac: string | undefined): boolean {
  return Boolean(mac && mac !== ZERO_MAC)
}

/** Prefer real Wi‑Fi/Ethernet adapters; deprioritize VPN/virtual (esp. important on macOS). */
function interfaceScore(name: string): number {
  if (VIRTUAL_IFACE_RE.test(name)) {
    return 0
  }

  if (/^en\d+$/i.test(name)) {
    return 100
  }

  if (/^eth\d+$/i.test(name) || /^wlan\d+$/i.test(name)) {
    return 95
  }

  if (/wi-?fi|wireless|ethernet|local area connection/i.test(name)) {
    return 90
  }

  return 40
}

/**
 * Primary NIC MAC for Windows and macOS.
 * Used to bind offline video at-rest encryption to this machine.
 * Returns "" when no usable adapter is found.
 */
export function getSystemMacAddress(): string {
  const interfaces = os.networkInterfaces()
  const candidates: Array<{ mac: string; score: number }> = []

  for (const [name, nets] of Object.entries(interfaces)) {
    if (!nets) {
      continue
    }

    const baseScore = interfaceScore(name)
    if (baseScore === 0) {
      continue
    }

    for (const net of nets) {
      if (net.internal || !isUsableMac(net.mac)) {
        continue
      }

      const score = baseScore + (isIpv4Family(net.family) ? 10 : 0)
      candidates.push({ mac: net.mac.toUpperCase(), score })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.mac ?? ''
}

/** Stable token mixed into offline crypto when no NIC MAC is available. */
export function getOfflineBindingMac(): string {
  return getSystemMacAddress() || 'macAddress'
}
