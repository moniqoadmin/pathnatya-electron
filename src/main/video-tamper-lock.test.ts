import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UNIQUE_TAMPER_LOCK_NAME } from '../shared/unique-asar-name'

let userDataDir = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir
  }
}))

const { clearVideoTamperLock, isVideoTampered, markVideoTampered } =
  await import('./video-tamper-lock')

describe('video-tamper-lock', () => {
  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'pathnatya-tamper-'))
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('is unset until a tamper wipe writes the marker', async () => {
    await expect(isVideoTampered()).resolves.toBe(false)

    await markVideoTampered()

    await expect(isVideoTampered()).resolves.toBe(true)
    await expect(readFile(join(userDataDir, UNIQUE_TAMPER_LOCK_NAME), 'utf8')).resolves.toMatch(
      /^\d{4}-/u
    )
  })

  it('clears so a later online login can use offline mode again', async () => {
    await markVideoTampered()
    await clearVideoTamperLock()

    await expect(isVideoTampered()).resolves.toBe(false)
    await expect(clearVideoTamperLock()).resolves.toBeUndefined()
  })
})
