import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/pathnatya-userData',
    getAppPath: () => '/tmp/pathnatya-app',
    isPackaged: false
  }
}))

vi.mock('./hls-service', () => ({
  wipeDownloadedVideo: vi.fn()
}))

const { isUnderMacInstallerVolume, isMacInstallerVolumeName } = await import('./drive-scanner')

describe('isMacInstallerVolumeName', () => {
  it('matches any volume name that contains Pathnatya Installer', () => {
    expect(isMacInstallerVolumeName('Pathnatya Installer')).toBe(true)
    expect(isMacInstallerVolumeName('Pathnatya Installer 1')).toBe(true)
    expect(isMacInstallerVolumeName('Pathnatya Installer 2')).toBe(true)
    expect(isMacInstallerVolumeName('USB')).toBe(false)
    expect(isMacInstallerVolumeName('Pathnatya 2026.app')).toBe(false)
  })
})

describe('isUnderMacInstallerVolume', () => {
  it('skips files on any /Volumes mount whose name contains Pathnatya Installer', () => {
    expect(isUnderMacInstallerVolume('/Volumes/Pathnatya Installer', 'darwin')).toBe(true)
    expect(
      isUnderMacInstallerVolume(
        '/Volumes/Pathnatya Installer/Pathnatya 2026.app/Contents/Resources/7f3a9c2e-4b1d-4e8a-9f06-2c5d8e1a0b47.asar',
        'darwin'
      )
    ).toBe(true)
    expect(
      isUnderMacInstallerVolume(
        '/Volumes/Pathnatya Installer 2/Pathnatya 2026.app/Contents/Resources/app.asar',
        'darwin'
      )
    ).toBe(true)
  })

  it('does not skip other volumes, Applications, or Windows paths', () => {
    expect(isUnderMacInstallerVolume('/Volumes/USB/Pathnatya 2026.app', 'darwin')).toBe(false)
    expect(isUnderMacInstallerVolume('/Applications/Pathnatya 2026.app', 'darwin')).toBe(false)
    expect(isUnderMacInstallerVolume('/Volumes/Pathnatya Installer', 'win32')).toBe(false)
  })
})
