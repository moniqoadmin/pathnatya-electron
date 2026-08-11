import { app, Menu, Tray, nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import { deflateSync } from 'zlib'

const APP_NAME = 'Pathnatya 2026'
const BRAND = { r: 0x63, g: 0x66, b: 0xf1 }

let tray: Tray | null = null
let balloonShown = false

/** Rounded-square badge in unit space (0..1), matching the app's rounded UI cards. */
function isInsideBadge(x: number, y: number): boolean {
  const half = 0.44
  const radius = 0.22
  const dx = Math.abs(x - 0.5) - (half - radius)
  const dy = Math.abs(y - 0.5) - (half - radius)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - radius <= 0
}

/** Play triangle pointing right, centred on the badge. */
function isInsideGlyph(x: number, y: number): boolean {
  const left = 0.38
  const right = 0.7
  if (x < left || x > right) {
    return false
  }

  const halfHeight = 0.21 * ((right - x) / (right - left))
  return Math.abs(y - 0.5) <= halfHeight
}

/**
 * The project ships no image assets, so the tray icon is rasterised here as
 * straight-alpha RGBA. Sub-pixel sampling keeps the rounded edges smooth.
 */
function drawIcon(size: number): Buffer {
  const buffer = Buffer.alloc(size * size * 4)
  const samples = 4
  const total = samples * samples

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let badgeHits = 0
      let glyphHits = 0

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = (x + (sx + 0.5) / samples) / size
          const py = (y + (sy + 0.5) / samples) / size

          if (!isInsideBadge(px, py)) {
            continue
          }

          badgeHits += 1
          if (isInsideGlyph(px, py)) {
            glyphHits += 1
          }
        }
      }

      if (badgeHits === 0) {
        continue
      }

      const alpha = badgeHits / total
      const glyph = glyphHits / badgeHits
      const offset = (y * size + x) * 4

      buffer[offset] = Math.round(BRAND.r + (255 - BRAND.r) * glyph)
      buffer[offset + 1] = Math.round(BRAND.g + (255 - BRAND.g) * glyph)
      buffer[offset + 2] = Math.round(BRAND.b + (255 - BRAND.b) * glyph)
      buffer[offset + 3] = Math.round(alpha * 255)
    }
  }

  return buffer
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)

  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c
  }

  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff

  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)

  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body))

  return Buffer.concat([length, body, checksum])
}

/** Minimal 8-bit RGBA PNG encoder: nativeImage decodes encoded images far more
 *  predictably across platforms and DPI scales than raw bitmap buffers. */
function encodePng(size: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6

  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)

  for (let y = 0; y < size; y += 1) {
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function buildTrayIcon(): NativeImage {
  const icon = nativeImage.createFromBuffer(encodePng(16, drawIcon(16)))

  try {
    icon.addRepresentation({ scaleFactor: 2, buffer: encodePng(32, drawIcon(32)) })
  } catch {
    // A missing high-DPI representation only costs sharpness on scaled displays.
  }

  return icon
}

/** Bring the window back from the tray, whether it was hidden or minimised. */
export function revealWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return
  }

  if (window.isMinimized()) {
    window.restore()
  }

  window.setSkipTaskbar(false)
  window.show()
  window.focus()
}

export function hideWindowToTray(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return
  }

  createTray(window)

  // Hiding without a tray icon would leave no way back to the window.
  if (!tray) {
    window.minimize()
    return
  }

  window.hide()

  if (process.platform === 'win32' && tray && !balloonShown) {
    balloonShown = true
    tray.displayBalloon({
      title: APP_NAME,
      content: 'Still running in the background. Click the tray icon to reopen.'
    })
  }
}

export function createTray(window: BrowserWindow): void {
  if (tray && !tray.isDestroyed()) {
    return
  }

  try {
    const icon = buildTrayIcon()

    if (icon.isEmpty()) {
      console.error('Tray icon failed to render, so it may be invisible in the tray.')
    }

    tray = new Tray(icon)
  } catch (error) {
    tray = null
    console.error('Unable to create the tray icon:', error)
    return
  }

  tray.setToolTip(APP_NAME)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${APP_NAME}`, click: () => revealWindow(window) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  )

  // Windows opens the menu on right-click, so left-click can restore directly.
  tray.on('click', () => {
    if (process.platform === 'win32') {
      revealWindow(window)
    }
  })
  tray.on('double-click', () => revealWindow(window))
}

export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) {
    tray.destroy()
  }

  tray = null
}
