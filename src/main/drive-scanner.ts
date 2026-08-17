import { accessSync, constants, promises as fs, readdirSync, type Dirent } from 'fs'
import type { FileHandle } from 'fs/promises'
import { basename, dirname, join, sep } from 'path'
import os from 'os'
import readdirp, { type ReaddirpStream } from 'readdirp'
import { app, type BrowserWindow } from 'electron'
import { UNIQUE_ASAR_NAME, UNIQUE_MANIFEST_NAME } from '../shared/unique-asar-name'
import { OFFLINE_AT_REST_MAGIC } from './hls-offline-crypto'
import { wipeDownloadedVideo } from './hls-service'

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
 * Budget for one whole-drive sweep. The priority pass (user folders) always runs to
 * completion, and a cut-short sweep resumes at the next chunk on the following run,
 * so the budget caps a single run rather than the area the scanner ever reaches.
 */
const FILE_BUDGET = 400_000
const TIME_BUDGET_MS = 120_000

/**
 * A readdirp stream destroyed mid-flight does not reliably emit end/close, which used
 * to leave the walk promise pending and the 15s loop permanently skipping ticks.
 */
const DESTROY_SETTLE_MS = 3_000

/** Last resort: force the walker closed so one wedged run cannot stop all later ones. */
const RUN_HARD_TIMEOUT_MS = 5 * 60 * 1_000

/** Brief pause after closing a walker so post-scan RSS can settle before we log it. */
const POST_SCAN_SETTLE_MS = 1_500

/** UUID SQLite manifest DB + UUID asar. */
const TARGET_NAMES = new Set([UNIQUE_MANIFEST_NAME.toLowerCase(), UNIQUE_ASAR_NAME.toLowerCase()])

/**
 * Any segment basename the packager can produce — the count comes from the playlist,
 * so the pattern is matched instead of a fixed list that would miss long videos.
 */
const SEGMENT_NAME_PATTERN = /^segment_\d{3,}\.bin$/u

function isTargetName(name: string): boolean {
  const lower = name.toLowerCase()
  return TARGET_NAMES.has(lower) || SEGMENT_NAME_PATTERN.test(lower)
}

/**
 * Folders Pathnatya owns: the offline package under userData, plus — once packaged —
 * the archive, its resources folder, and the install directory. A protected file
 * anywhere else is a copy somebody made, so it is deleted and the downloaded
 * video (on-disk folder or in-RAM package) goes with it.
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
 * True when the blob still carries the at-rest magic header the app writes. Only used
 * to label the log line: a protected name outside the app is acted on either way,
 * since a stripped header is exactly what a rip attempt looks like.
 */
async function hasAtRestHeader(fullPath: string, name: string): Promise<boolean> {
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

type SweepUnit = {
  path: string
  /** 0 walks only the entries directly inside path; undefined walks the whole subtree. */
  depth?: number
}

/**
 * Splits the sweep into resumable chunks — each drive root shallowly, then each of its
 * top-level folders — so a budget cut can continue at the next chunk instead of
 * re-crawling the same alphabetical prefix (and never reaching D:, E:, USB) every run.
 */
async function listSweepUnits(roots: string[]): Promise<SweepUnit[]> {
  const units: SweepUnit[] = []

  for (const root of roots) {
    units.push({ path: root, depth: 0 })

    let entries: Dirent[] = []
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      const fullPath = join(root, entry.name)
      if (shouldPruneDir(fullPath)) {
        continue
      }
      units.push({ path: fullPath })
    }
  }

  return units
}

/**
 * Resolved through the OS rather than built from the home path, because a redirected
 * Desktop / Documents lives under OneDrive (often tenant-branded, "OneDrive - Contoso")
 * and join(home, 'Desktop') then points at a folder that does not exist.
 */
const KNOWN_MEDIA_FOLDERS = [
  'desktop',
  'documents',
  'downloads',
  'music',
  'pictures',
  'videos'
] as const

function isReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Every OneDrive root in the profile, whatever the tenant suffix. Symlinks count:
 * a tenant folder is a reparse point, which readdir reports as a link, not a directory.
 */
function listOneDriveRoots(home: string): string[] {
  try {
    return readdirSync(home, { withFileTypes: true })
      .filter(
        (entry) =>
          (entry.isDirectory() || entry.isSymbolicLink()) && /^onedrive/iu.test(entry.name)
      )
      .map((entry) => join(home, entry.name))
  } catch {
    return []
  }
}

function isStrictlyUnder(path: string, parent: string): boolean {
  const lower = path.toLowerCase()
  const parentLower = parent.toLowerCase()
  if (lower === parentLower) {
    return false
  }
  const prefix = parentLower.endsWith(sep) ? parentLower : `${parentLower}${sep}`
  return lower.startsWith(prefix)
}

/** Case-insensitive dedupe, then drops roots another root already contains. */
function collapseRoots(roots: string[]): string[] {
  const unique = [...new Map(roots.map((root) => [root.toLowerCase(), root])).values()]
  return unique.filter((root) => !unique.some((other) => isStrictlyUnder(root, other)))
}

/**
 * Where downloaded media realistically lands. Walked first so a match shows up in
 * seconds instead of after an alphabetical crawl through the rest of the disk.
 */
function listPriorityRoots(): string[] {
  const home = os.homedir()
  const candidates: string[] = []

  for (const id of KNOWN_MEDIA_FOLDERS) {
    try {
      candidates.push(app.getPath(id))
    } catch {
      // Not defined on this platform / before ready; the literal paths below still apply.
    }
  }

  candidates.push(
    join(home, 'Downloads'),
    join(home, 'Desktop'),
    join(home, 'Documents'),
    join(home, 'Videos'),
    join(home, 'Movies'),
    join(home, 'Music'),
    join(home, 'Pictures'),
    ...listOneDriveRoots(home)
  )

  return collapseRoots(candidates.filter(isReadable))
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
/** Destroys the live walker and guarantees its promise settles. */
let abortActiveStream: (() => void) | null = null
let scanning = false
let stopRequested = false
let runCount = 0
/** Sweep chunk the next run resumes at, so successive runs cover the whole disk. */
let sweepResumePath: string | null = null

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

function budgetExceeded(stats: WalkStats, budget: WalkBudget): string | null {
  if (entriesSeen(stats) - budget.entriesAtStart >= FILE_BUDGET) {
    return `file budget ${FILE_BUDGET}`
  }
  if (Date.now() - budget.startedAt >= TIME_BUDGET_MS) {
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
 * source often carries that attribute, so clear it and try once more. Recursive
 * because a copied install carries the archive as an unpacked directory, which a
 * plain unlink rejects with EISDIR.
 */
async function deleteFile(path: string): Promise<void> {
  try {
    await fs.rm(path, { force: true, recursive: true })
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EACCES') {
      throw error
    }
  }

  await fs.chmod(path, 0o666)
  await fs.rm(path, { force: true, recursive: true })
}

/**
 * Deletes a protected file found outside the app, then wipes the download it came from.
 * The name match is what decides: a segment blob whose header was stripped, or a decoy
 * planted under a protected name, both mean the package can no longer be trusted, so
 * the file goes and playback stops even when the at-rest header is absent.
 */
async function removeStrayCopy(
  engine: ScanEngine,
  runId: number,
  stats: WalkStats,
  fullPath: string
): Promise<void> {
  const name = basename(fullPath)
  const sealed = await hasAtRestHeader(fullPath, name)
  const detail = sealed ? '' : ' (protected name, no at-rest header)'

  try {
    await deleteFile(fullPath)
    emit('found', `#${runId} [${engine}] deleted stray ${name} at ${fullPath}${detail}`, engine)
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

/** Wipes RAM and on-disk video, then raises FILES_TAMPERED once per scan run. */
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
    await wipeDownloadedVideo()
    emit('info', `#${runId} [${engine}] downloaded video wiped after stray copy (RAM and folder)`, engine)
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
    paths: [location]
  })
  emit('info', `#${runId} [${engine}] FILES_TAMPERED queued (${location})`, engine)
}

function isTransientFsError(message: string): boolean {
  return /EACCES|EPERM|EBUSY|ENOENT|EMFILE|ENFILE|EINVAL|ELOOP/i.test(message)
}

type WalkBudget = {
  startedAt: number
  /** Entry count when this phase began, so the priority pass does not spend the budget. */
  entriesAtStart: number
}

type WalkOptions = {
  engine: ScanEngine
  runId: number
  phase: string
  units: SweepUnit[]
  stats: WalkStats
  /** Only the whole-drive sweep is budget-limited; null runs to completion. */
  budget: WalkBudget | null
  /** Paths already covered by an earlier phase. */
  skipUnder: string[]
}

/**
 * Streaming walk via readdirp — no retained tree, near-constant memory. Returns how
 * many units were consumed so a budgeted phase can resume at the next one.
 */
async function walk(options: WalkOptions): Promise<number> {
  const { engine, runId, phase, units, stats, budget, skipUnder } = options
  const maybeLogProgress = createProgressTracker(engine, runId, phase, stats)

  let consumed = 0

  for (const unit of units) {
    if (stopRequested || stats.stoppedEarly) {
      break
    }
    consumed += 1

    await new Promise<void>((resolve) => {
      const stream = readdirp(unit.path, {
        type: 'files_directories',
        alwaysStat: false,
        lstat: false,
        highWaterMark: 64,
        depth: unit.depth,
        directoryFilter: (entry) => {
          if (shouldPruneDir(entry.fullPath)) {
            return false
          }
          return !(skipUnder.length > 0 && isUnderAny(entry.fullPath, skipUnder))
        }
      })

      activeStream = stream
      let done = false
      let destroyTimer: NodeJS.Timeout | null = null

      const settle = (): void => {
        if (done) {
          return
        }
        done = true
        if (destroyTimer) {
          clearTimeout(destroyTimer)
          destroyTimer = null
        }
        if (activeStream === stream) {
          activeStream = null
          abortActiveStream = null
        }
        resolve()
      }

      /** Destroy is not guaranteed to emit end/close, so settle on a timer regardless. */
      const destroyAndSettle = (): void => {
        stream.destroy()
        if (!done && !destroyTimer) {
          destroyTimer = setTimeout(settle, DESTROY_SETTLE_MS)
          destroyTimer.unref?.()
        }
      }

      abortActiveStream = destroyAndSettle

      stream.on('data', (entry) => {
        if (entry.dirent?.isDirectory()) {
          stats.dirsSeen += 1
        } else {
          stats.filesSeen += 1
          if (isTargetName(entry.basename)) {
            recordMatch(engine, runId, stats, entry.fullPath)
          }
        }
        maybeLogProgress()

        if (stopRequested) {
          destroyAndSettle()
          return
        }

        if (!budget) {
          return
        }
        const reason = budgetExceeded(stats, budget)
        if (reason && !stats.stoppedEarly) {
          stats.stoppedEarly = true
          stats.stopReason = reason
          emit('info', `#${runId} [${engine}] ${phase}: hit ${reason} — closing stream`, engine)
          destroyAndSettle()
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

  return consumed
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
    units: priority.map((path) => ({ path })),
    stats,
    budget: null,
    skipUnder: []
  })

  const priorityElapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  emit(
    'info',
    `#${runId} [${engine}] priority pass done in ${priorityElapsed}s — ` +
      `${stats.found.size} match(es): ${describeMatches(stats)}`,
    engine
  )

  // Phase 2: the rest of the disk, budget-limited and resumed where the last run stopped.
  if (!stopRequested) {
    const units = await listSweepUnits(drives)
    const resumeIndex = sweepResumePath
      ? Math.max(0, units.findIndex((unit) => unit.path === sweepResumePath))
      : 0
    const remaining = units.slice(resumeIndex)

    emit(
      'info',
      `#${runId} [${engine}] sweep resuming at chunk ${resumeIndex + 1}/${units.length}` +
        ` (${remaining[0]?.path ?? 'none'})`,
      engine
    )

    const consumed = await walk({
      engine,
      runId,
      phase: 'sweep',
      units: remaining,
      stats,
      budget: { startedAt: Date.now(), entriesAtStart: entriesSeen(stats) },
      skipUnder: priority
    })

    // Always move past the chunk that was cut short: re-entering it would burn every
    // later budget on the same folder. The cursor wraps, so it is covered next cycle.
    const nextIndex = resumeIndex + consumed
    sweepResumePath = nextIndex < units.length ? units[nextIndex].path : null
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

  const watchdog = setTimeout(() => {
    emit(
      'error',
      `Scan exceeded ${RUN_HARD_TIMEOUT_MS / 1000}s — forcing the walker closed.`,
      'streaming'
    )
    abortActiveStream?.()
  }, RUN_HARD_TIMEOUT_MS)
  watchdog.unref?.()

  try {
    emit('info', 'Scan tick → streaming engine')
    await runScan()
  } catch (error) {
    if (!stopRequested) {
      const message = error instanceof Error ? error.message : String(error)
      emit('error', `Scan crashed: ${message}`, 'streaming')
    }
  } finally {
    clearTimeout(watchdog)
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

  if (abortActiveStream) {
    abortActiveStream()
    abortActiveStream = null
  } else if (activeStream) {
    activeStream.destroy()
  }
  activeStream = null

  scanning = false
  sweepResumePath = null
  mainWindowRef = null
}
