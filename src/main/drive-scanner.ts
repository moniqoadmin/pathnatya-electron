import { accessSync, constants, promises as fs } from 'fs'
import type { FileHandle } from 'fs/promises'
import { basename, dirname, join, sep } from 'path'
import os from 'os'
import readdirp, { type ReaddirpStream } from 'readdirp'
import { app, type BrowserWindow } from 'electron'
import { UNIQUE_ASAR_NAME, UNIQUE_MANIFEST_NAME } from '../shared/unique-asar-name'
import { OFFLINE_AT_REST_MAGIC } from './hls-offline-crypto'
import { deleteOfflineVideo } from './hls-offline'

export type ScanEngine = 'streaming'

export type ScanLogLevel = 'info' | 'found' | 'progress' | 'summary' | 'error'

export type ScanLogEntry = {
  level: ScanLogLevel
  message: string
  engine: ScanEngine | null
  /** ms since epoch, set in main so the renderer just renders. */
  time: number
}

/** How often the whole walk is kicked off again (skipped while one is running). */
const SCAN_INTERVAL_MS = 15_000

/** Progress lines are throttled to at most one per this window to spare the UI. */
const PROGRESS_LOG_MS = 1_000

/**
 * Budget for the whole-drive sweep only. The priority pass (user folders) always
 * runs to completion, so downloads are found even when the sweep is cut short.
 */
const FILE_BUDGET = 400_000
const TIME_BUDGET_MS = 120_000

/** Brief pause after closing a walker so post-scan RSS can settle before we log it. */
const POST_SCAN_SETTLE_MS = 1_500

const TOTAL_SEGMENTS = 36

/** UUID SQLite manifest DB + UUID asar + segment_000.bin .. segment_035.bin */
function buildTargetNames(): Set<string> {
  const names = new Set<string>([UNIQUE_MANIFEST_NAME, UNIQUE_ASAR_NAME])
  for (let i = 0; i < TOTAL_SEGMENTS; i += 1) {
    names.add(`segment_${String(i).padStart(3, '0')}.bin`)
  }
  return names
}

const TARGET_NAMES = buildTargetNames()

/**
 * Folders Pathnatya owns: the offline package under userData, plus — once packaged —
 * the archive, its resources folder, and the install directory. A protected file
 * anywhere else is a copy somebody made, so it is deleted and the downloaded
 * package goes with it.
 *
 * Unpackaged, app.getAppPath() is the whole source tree, which would make every
 * build output under it immune; only userData is owned in that case.
 */
let ownedRootsCache: string[] | null = null

function ownedRoots(): string[] {
  if (ownedRootsCache) {
    return ownedRootsCache
  }

  const roots = new Set<string>()
  try {
    roots.add(app.getPath('userData'))

    if (app.isPackaged) {
      roots.add(app.getAppPath())
      roots.add(dirname(app.getPath('exe')))
      if (process.resourcesPath) {
        roots.add(process.resourcesPath)
      }
    }
  } catch {
    // app paths are unavailable before ready; the scan only starts after that.
  }

  ownedRootsCache = [...roots]
  return ownedRootsCache
}

function isInsideApp(path: string): boolean {
  return isUnderAny(path, ownedRoots())
}

/**
 * Guards against wiping an unrelated file that happens to be called segment_000.bin:
 * every blob the app writes carries the at-rest magic header, and the archive name
 * is a UUID nothing else would use.
 */
async function isPathnatyaFile(fullPath: string, name: string): Promise<boolean> {
  if (name === UNIQUE_ASAR_NAME) {
    return true
  }

  let handle: FileHandle | null = null
  try {
    handle = await fs.open(fullPath, 'r')
    const header = Buffer.alloc(OFFLINE_AT_REST_MAGIC.length)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    return bytesRead === header.length && header.equals(OFFLINE_AT_REST_MAGIC)
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/**
 * Directories that hold no user downloads but dominate a full-drive walk. Skipping
 * them is what lets the sweep reach real user data instead of dying in caches.
 */
const PRUNED_DIR_NAMES = new Set([
  '$recycle.bin',
  'system volume information',
  '$windows.~bt',
  '$windows.~ws',
  'windows',
  'winsxs',
  'msocache',
  'recovery',
  'node_modules',
  '.git',
  'temp',
  'tmp',
  'cache',
  'cache_data',
  'caches',
  'code cache',
  'gpucache',
  'serviceworker',
  '.cursor',
  '.vscode-cpptools'
])

function shouldPruneDir(path: string): boolean {
  const name = basename(path).toLowerCase()
  return PRUNED_DIR_NAMES.has(name)
}

/** Root paths to walk. Windows: every mounted drive letter. POSIX: filesystem root. */
function listDriveRoots(): string[] {
  if (process.platform !== 'win32') {
    return ['/']
  }

  const roots: string[] = []
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    const root = `${String.fromCharCode(code)}:\\`
    try {
      accessSync(root, constants.R_OK)
      roots.push(root)
    } catch {
      // Drive letter not mounted / not readable.
    }
  }
  return roots
}

/**
 * Where downloaded media realistically lands. Walked first so a match shows up in
 * seconds instead of after an alphabetical crawl through the rest of the disk.
 */
function listPriorityRoots(): string[] {
  const home = os.homedir()
  const candidates = [
    join(home, 'Downloads'),
    join(home, 'Desktop'),
    join(home, 'Documents'),
    join(home, 'Videos'),
    join(home, 'Movies'),
    join(home, 'Music'),
    join(home, 'Pictures'),
    join(home, 'OneDrive')
  ]

  return candidates.filter((path) => {
    try {
      accessSync(path, constants.R_OK)
      return true
    } catch {
      return false
    }
  })
}

/** Drops drive sweeps of paths already covered by the priority pass. */
function isUnderAny(path: string, roots: string[]): boolean {
  const normalized = path.toLowerCase()
  return roots.some((root) => {
    const prefix = root.toLowerCase().endsWith(sep) ? root.toLowerCase() : `${root.toLowerCase()}${sep}`
    return normalized === root.toLowerCase() || normalized.startsWith(prefix)
  })
}

function memorySnapshot(): { rssMb: number; heapMb: number; label: string } {
  const { rss, heapUsed } = process.memoryUsage()
  const rssMb = rss / 1024 / 1024
  const heapMb = heapUsed / 1024 / 1024
  return {
    rssMb,
    heapMb,
    label: `rss=${rssMb.toFixed(1)}MB heap=${heapMb.toFixed(1)}MB`
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let mainWindowRef: BrowserWindow | null = null
let intervalId: NodeJS.Timeout | null = null
let activeStream: ReaddirpStream | null = null
let scanning = false
let stopRequested = false
let runCount = 0

function emit(level: ScanLogLevel, message: string, engine: ScanEngine | null = null): void {
  const entry: ScanLogEntry = { level, message, engine, time: Date.now() }

  const tag = engine ? `scan:${engine}:${level}` : `scan:${level}`
  console.log(`[${tag}] ${message}`)

  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('scan-log', entry)
  }
}

type WalkStats = {
  dirsSeen: number
  filesSeen: number
  peakRssMb: number
  stoppedEarly: boolean
  stopReason: string
  /** Absolute paths of every target file hit, deduped across phases. */
  found: Set<string>
  /** Deletions started from the stream handler, awaited before the run is summarised. */
  pending: Promise<void>[]
  /** Ensures FILES_TAMPERED is only queued once per scan run. */
  tamperedQueued: boolean
}

function createStats(baselineRssMb: number): WalkStats {
  return {
    dirsSeen: 0,
    filesSeen: 0,
    peakRssMb: baselineRssMb,
    stoppedEarly: false,
    stopReason: '',
    found: new Set<string>(),
    pending: [],
    tamperedQueued: false
  }
}

function entriesSeen(stats: WalkStats): number {
  return stats.dirsSeen + stats.filesSeen
}

function budgetExceeded(stats: WalkStats, startedAt: number): string | null {
  if (entriesSeen(stats) >= FILE_BUDGET) {
    return `file budget ${FILE_BUDGET}`
  }
  if (Date.now() - startedAt >= TIME_BUDGET_MS) {
    return `time budget ${TIME_BUDGET_MS / 1000}s`
  }
  return null
}

function createProgressTracker(
  engine: ScanEngine,
  runId: number,
  phase: string,
  stats: WalkStats
): () => void {
  let lastProgressAt = 0

  return (): void => {
    const now = Date.now()
    if (now - lastProgressAt < PROGRESS_LOG_MS) {
      return
    }
    lastProgressAt = now

    const mem = memorySnapshot()
    stats.peakRssMb = Math.max(stats.peakRssMb, mem.rssMb)
    emit(
      'progress',
      `#${runId} [${engine}] ${phase}: ${stats.dirsSeen} dirs, ${stats.filesSeen} files, ` +
        `${stats.found.size} found (${mem.label}, peakRss=${stats.peakRssMb.toFixed(1)}MB)`,
      engine
    )
  }
}

function recordMatch(engine: ScanEngine, runId: number, stats: WalkStats, fullPath: string): void {
  if (stats.found.has(fullPath)) {
    return
  }
  stats.found.add(fullPath)

  // Inside userData / resources / the install folder it is the app's own copy.
  const own = isInsideApp(fullPath)
  const name = basename(fullPath)
  emit(
    'found',
    `#${runId} [${engine}] Found ${name} at ${fullPath}` +
      (own ? " — app's own copy, left in place" : ''),
    engine
  )

  if (own) {
    return
  }

  stats.pending.push(removeStrayCopy(engine, runId, stats, fullPath))
}

/**
 * Windows refuses to unlink a read-only file, and a copy dragged off a locked
 * source often carries that attribute, so clear it and try once more.
 */
async function deleteFile(path: string): Promise<void> {
  try {
    await fs.rm(path, { force: true })
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EACCES') {
      throw error
    }
  }

  await fs.chmod(path, 0o666)
  await fs.rm(path, { force: true })
}

/** Deletes a protected file found outside the app, then wipes the download it came from. */
async function removeStrayCopy(
  engine: ScanEngine,
  runId: number,
  stats: WalkStats,
  fullPath: string
): Promise<void> {
  const name = basename(fullPath)

  if (!(await isPathnatyaFile(fullPath, name))) {
    emit('info', `#${runId} [${engine}] ${fullPath} is not a Pathnatya file — left alone`, engine)
    return
  }

  try {
    await deleteFile(fullPath)
    emit('found', `#${runId} [${engine}] deleted stray ${name} at ${fullPath}`, engine)
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException
    emit(
      'error',
      `#${runId} [${engine}] could not delete ${fullPath}: ${code ?? 'error'} ${message}`,
      engine
    )
  }

  await reportStrayCopy(engine, runId, stats, fullPath)
}

/** Wipes the offline package and raises FILES_TAMPERED once per scan run. */
async function reportStrayCopy(
  engine: ScanEngine,
  runId: number,
  stats: WalkStats,
  fullPath: string
): Promise<void> {
  if (stats.tamperedQueued) {
    return
  }
  stats.tamperedQueued = true

  try {
    await deleteOfflineVideo()
    emit('info', `#${runId} [${engine}] downloaded video wiped after stray copy`, engine)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit('error', `#${runId} [${engine}] could not wipe downloaded video: ${message}`, engine)
  }

  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    return
  }

  // Parent folder of the copy — full path up to the folder, no file name.
  const location = dirname(fullPath)
  mainWindowRef.webContents.send('app-log', {
    event: 'FILES_TAMPERED',
    tampered: true,
    threat: true,
    paths: [location]
  })
  emit('info', `#${runId} [${engine}] FILES_TAMPERED queued (${location})`, engine)
}

function isTransientFsError(message: string): boolean {
  return /EACCES|EPERM|EBUSY|ENOENT|EMFILE|ENFILE|EINVAL|ELOOP/i.test(message)
}

type WalkOptions = {
  engine: ScanEngine
  runId: number
  phase: string
  roots: string[]
  stats: WalkStats
  /** Only the whole-drive sweep is budget-limited. */
  budgeted: boolean
  startedAt: number
  /** Paths already covered by an earlier phase. */
  skipUnder: string[]
}

/** Streaming walk via readdirp — no retained tree, near-constant memory. */
async function walk(options: WalkOptions): Promise<void> {
  const { engine, runId, phase, roots, stats, budgeted, startedAt, skipUnder } = options
  const maybeLogProgress = createProgressTracker(engine, runId, phase, stats)

  for (const root of roots) {
    if (stopRequested || stats.stoppedEarly) {
      break
    }

    await new Promise<void>((resolve) => {
      const stream = readdirp(root, {
        type: 'files_directories',
        alwaysStat: false,
        lstat: false,
        highWaterMark: 64,
        directoryFilter: (entry) => {
          if (shouldPruneDir(entry.fullPath)) {
            return false
          }
          return !(skipUnder.length > 0 && isUnderAny(entry.fullPath, skipUnder))
        }
      })

      activeStream = stream
      let done = false

      const settle = (): void => {
        if (done) {
          return
        }
        done = true
        if (activeStream === stream) {
          activeStream = null
        }
        resolve()
      }

      stream.on('data', (entry) => {
        if (entry.dirent?.isDirectory()) {
          stats.dirsSeen += 1
        } else {
          stats.filesSeen += 1
          if (TARGET_NAMES.has(entry.basename)) {
            recordMatch(engine, runId, stats, entry.fullPath)
          }
        }
        maybeLogProgress()

        if (!budgeted) {
          return
        }
        const reason = budgetExceeded(stats, startedAt)
        if (reason && !stats.stoppedEarly) {
          stats.stoppedEarly = true
          stats.stopReason = reason
          emit('info', `#${runId} [${engine}] ${phase}: hit ${reason} — closing stream`, engine)
          stream.destroy()
        }
      })

      stream.on('warn', (error: Error) => {
        if (!isTransientFsError(error.message)) {
          emit('error', `#${runId} [${engine}] ${phase}: ${error.message}`, engine)
        }
      })

      stream.on('error', (error: Error) => {
        if (!stats.stoppedEarly && !isTransientFsError(error.message)) {
          emit('error', `#${runId} [${engine}] ${phase}: ${error.message}`, engine)
        }
        settle()
      })

      stream.on('end', settle)
      stream.on('close', settle)

      if (stopRequested) {
        stream.destroy()
        settle()
      }
    })
  }
}

function describeMatches(stats: WalkStats): string {
  if (stats.found.size === 0) {
    return 'none'
  }

  const names = [...stats.found].map((path) => basename(path)).sort()
  const shown = names.slice(0, 8).join(', ')
  return names.length > 8 ? `${shown} (+${names.length - 8} more)` : shown
}

async function runScan(): Promise<void> {
  const engine: ScanEngine = 'streaming'
  const drives = listDriveRoots()
  const priority = listPriorityRoots()

  if (drives.length === 0 && priority.length === 0) {
    emit('error', 'No readable drives found to scan.')
    return
  }

  runCount += 1
  const runId = runCount
  const startedAt = Date.now()
  const baseline = memorySnapshot()
  const stats = createStats(baseline.rssMb)

  emit(
    'info',
    `#${runId} [${engine}] started — priority: ${priority.join(', ') || 'none'} | ` +
      `sweep: ${drives.join(', ')} (${baseline.label})`,
    engine
  )
  emit('info', `#${runId} [${engine}] app folders (never deleted): ${ownedRoots().join(' | ')}`, engine)

  // Phase 1: user folders, always to completion.
  await walk({
    engine,
    runId,
    phase: 'priority',
    roots: priority,
    stats,
    budgeted: false,
    startedAt,
    skipUnder: []
  })

  const priorityElapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  emit(
    'info',
    `#${runId} [${engine}] priority pass done in ${priorityElapsed}s — ` +
      `${stats.found.size} match(es): ${describeMatches(stats)}`,
    engine
  )

  // Phase 2: the rest of the disk, budget-limited.
  if (!stopRequested) {
    await walk({
      engine,
      runId,
      phase: 'sweep',
      roots: drives,
      stats,
      budgeted: true,
      startedAt,
      skipUnder: priority
    })
  }

  await Promise.allSettled(stats.pending)

  await sleep(POST_SCAN_SETTLE_MS)
  const after = memorySnapshot()
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  const delta = after.rssMb - baseline.rssMb

  emit(
    'summary',
    `#${runId} [${engine}] done in ${elapsed}s — ${stats.dirsSeen} dirs, ${stats.filesSeen} files, ` +
      `${stats.found.size} matches [${describeMatches(stats)}]` +
      (stats.stoppedEarly ? ` (sweep stopped: ${stats.stopReason})` : '') +
      ` | startRss=${baseline.rssMb.toFixed(1)}MB ` +
      `peakRss=${stats.peakRssMb.toFixed(1)}MB afterRss=${after.rssMb.toFixed(1)}MB ` +
      `Δ=${delta >= 0 ? '+' : ''}${delta.toFixed(1)}MB`,
    engine
  )
}

/** Runs one scan now (unless one is in flight) and re-arms the 15s cadence. */
async function tick(): Promise<void> {
  if (scanning) {
    emit('info', 'Previous scan still running — skipping this 15s tick.')
    return
  }

  scanning = true
  stopRequested = false
  try {
    emit('info', 'Scan tick → streaming engine')
    await runScan()
  } catch (error) {
    if (!stopRequested) {
      const message = error instanceof Error ? error.message : String(error)
      emit('error', `Scan crashed: ${message}`, 'streaming')
    }
  } finally {
    scanning = false
  }
}

/** Starts the drive-scan loop: one immediate walk, then every 15 seconds. */
export function startDriveScanLoop(window: BrowserWindow): void {
  stopDriveScanLoop()

  mainWindowRef = window
  void tick()
  intervalId = setInterval(() => void tick(), SCAN_INTERVAL_MS)
}

export function stopDriveScanLoop(): void {
  stopRequested = true

  if (intervalId !== null) {
    clearInterval(intervalId)
    intervalId = null
  }

  if (activeStream) {
    activeStream.destroy()
    activeStream = null
  }

  scanning = false
  mainWindowRef = null
}
