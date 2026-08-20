import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    relaunch: (): void => undefined,
    exit: (): void => undefined
  },
  shell: { openExternal: async () => undefined },
  systemPreferences: { isTrustedAccessibilityClient: () => false }
}))

vi.mock('child_process', async () => {
  const { promisify } = await import('util')
  const execFile = (): void => undefined
  Object.defineProperty(execFile, promisify.custom, {
    value: async () => ({ stdout: '1\n' })
  })
  return {
    execFile,
    spawnSync: () => ({ status: 0, stdout: '', stderr: '', error: undefined })
  }
})

const { macFolderProbeIsGranted } = await import('./permissions-guard')

describe('macFolderProbeIsGranted', () => {
  it('fails closed when the user denies the folder prompt', () => {
    expect(
      macFolderProbeIsGranted({
        folderMissing: false,
        lookupCode: 'EPERM',
        lsStatus: 1,
        lsTimedOut: false,
        lsOutput: 'ls: Desktop: Operation not permitted\n'
      })
    ).toBe(false)
  })

  it('fails closed when ls reports permission denied even if lookup looked like ENOENT', () => {
    expect(
      macFolderProbeIsGranted({
        folderMissing: false,
        lookupCode: 'ENOENT',
        lsStatus: 1,
        lsTimedOut: false,
        lsOutput: 'Permission denied'
      })
    ).toBe(false)
  })

  it('does not treat a pending dialog timeout as granted', () => {
    expect(
      macFolderProbeIsGranted({
        folderMissing: false,
        lookupCode: 'ENOENT',
        lsStatus: null,
        lsTimedOut: true,
        lsOutput: ''
      })
    ).toBe(false)
  })

  it('treats a missing folder as granted', () => {
    expect(
      macFolderProbeIsGranted({
        folderMissing: true,
        lsStatus: null,
        lsTimedOut: false,
        lsOutput: ''
      })
    ).toBe(true)
  })

  it('grants when ls can list the folder', () => {
    expect(
      macFolderProbeIsGranted({
        folderMissing: false,
        lookupCode: 'ENOENT',
        lsStatus: 0,
        lsTimedOut: false,
        lsOutput: ''
      })
    ).toBe(true)
  })
})
