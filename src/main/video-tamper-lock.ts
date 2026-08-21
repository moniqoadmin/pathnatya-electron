import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { UNIQUE_TAMPER_LOCK_NAME } from '../shared/unique-asar-name'

function lockFilePath(): string {
  return join(app.getPath('userData'), UNIQUE_TAMPER_LOCK_NAME)
}

/** True after a video tamper wipe until a successful online login. */
export async function isVideoTampered(): Promise<boolean> {
  try {
    await fs.access(lockFilePath())
    return true
  } catch {
    return false
  }
}

/**
 * Set when the on-disk video is wiped for tamper. Blocks offline login so the
 * user cannot re-enter with a session that no longer has a playable package.
 */
export async function markVideoTampered(): Promise<void> {
  await fs.writeFile(lockFilePath(), `${new Date().toISOString()}\n`, 'utf8')
}

/** Delete the lock file only when it is present. */
export async function clearVideoTamperLock(): Promise<void> {
  if (!(await isVideoTampered())) {
    return
  }

  try {
    await fs.unlink(lockFilePath())
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw error
    }
  }
}
