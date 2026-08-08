/** Windows: MAC only (literal "macAddress" if unavailable). macOS: IOPlatformUUID. */
export async function getDeviceId(): Promise<string> {
  const api = window.pathnatya

  if (typeof api.getDeviceId === 'function') {
    const result = await api.getDeviceId()
    console.log('Device id:', result.id, `(${result.type || 'none'})`)
    return result.id
  }

  // Legacy preload fallback (HMR without full restart) — Windows-oriented only.
  if (api.getPlatform?.() === 'darwin') {
    throw new Error('Device identifier API is unavailable. Restart the app.')
  }

  if (typeof api.getSystemMacAddress === 'function') {
    const mac = await api.getSystemMacAddress()
    if (mac) {
      console.log('Device id:', mac, '(mac)')
      return mac
    }
  }

  console.log('Device id: macAddress (mac)')
  return 'macAddress'
}
