import { watch, type FSWatcher } from 'chokidar'
import { existsSync } from 'fs'
import { join } from 'path'
import { app, type BrowserWindow } from 'electron'
import { UNIQUE_ASAR_NAME } from '../shared/unique-asar-name'

type TamperReporter = (window: BrowserWindow, path: string) => void

let watcher: FSWatcher | null = null
let reported = false

function uniqueAsarPath(): string {
  return join(process.resourcesPath, UNIQUE_ASAR_NAME)
}

function reportTamper(window: BrowserWindow, path: string, report: TamperReporter): void {
  if (reported || window.isDestroyed()) {
    return
  }
  reported = true
  report(window, path)
}

/**
 * Watch the UUID-named application archive after install.
 * Missing, deleted, or modified archive → FILES_TAMPERED.
 */
export function startAsarWatch(window: BrowserWindow, report: TamperReporter): void {
  if (!app.isPackaged || watcher) {
    return
  }

  const target = uniqueAsarPath()
  if (!existsSync(target)) {
    reportTamper(window, target, report)
    return
  }

  reported = false
  watcher = watch(target, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
  })

  const onChange = (): void => {
    reportTamper(window, target, report)
  }

  watcher.on('unlink', onChange)
  watcher.on('change', onChange)
  watcher.on('error', onChange)
}

export function stopAsarWatch(): void {
  if (!watcher) {
    return
  }
  void watcher.close()
  watcher = null
  reported = false
}
