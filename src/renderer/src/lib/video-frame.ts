/** Seconds for one full loop of the watermark path. */
export const WATERMARK_DURATION_S = 24

/**
 * x/y are 0–1 positions of the watermark's top-left inside the padded,
 * text-sized safe rectangle (not raw video pixels). That keeps the full
 * phone number on-screen on both the left and right edges.
 */
const WATERMARK_KEYFRAMES: Array<{ t: number; x: number; y: number }> = [
  { t: 0, x: 0, y: 0 },
  { t: 0.2, x: 0.95, y: 0.09 },
  { t: 0.4, x: 1, y: 0.86 },
  { t: 0.6, x: 0.46, y: 1 },
  { t: 0.8, x: 0.05, y: 0.66 },
  { t: 1, x: 0, y: 0 }
]

export function watermarkPosition(progress: number): { x: number; y: number } {
  const p = ((progress % 1) + 1) % 1

  for (let i = 0; i < WATERMARK_KEYFRAMES.length - 1; i += 1) {
    const from = WATERMARK_KEYFRAMES[i]
    const to = WATERMARK_KEYFRAMES[i + 1]

    if (p >= from.t && p <= to.t) {
      const local = (p - from.t) / (to.t - from.t)
      return {
        x: from.x + (to.x - from.x) * local,
        y: from.y + (to.y - from.y) * local
      }
    }
  }

  return { x: WATERMARK_KEYFRAMES[0].x, y: WATERMARK_KEYFRAMES[0].y }
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00'
  }

  const total = Math.floor(seconds)
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

/**
 * Letterboxes the current video frame onto the canvas and stamps the moving
 * watermark. The `<video>` element itself stays hidden so the frames the user
 * sees always carry the watermark.
 */
export function drawWatermarkedFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  watermarkText: string
): void {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
    return
  }

  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (width === 0 || height === 0) {
    return
  }

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return
  }

  const videoRatio = video.videoWidth / video.videoHeight
  const canvasRatio = width / height
  let drawWidth = width
  let drawHeight = height
  let offsetX = 0
  let offsetY = 0

  if (canvasRatio > videoRatio) {
    drawHeight = height
    drawWidth = drawHeight * videoRatio
    offsetX = (width - drawWidth) / 2
  } else {
    drawWidth = width
    drawHeight = drawWidth / videoRatio
    offsetY = (height - drawHeight) / 2
  }

  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight)

  const progress = (video.currentTime % WATERMARK_DURATION_S) / WATERMARK_DURATION_S
  const { x, y } = watermarkPosition(progress)
  const fontSize = Math.max(28, Math.min(drawWidth * 0.06, 64))

  ctx.save()
  ctx.font = `800 ${fontSize}px "Segoe UI", system-ui, sans-serif`
  ctx.fillStyle = 'rgba(255, 255, 255, 0.45)'
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  ctx.shadowColor = 'rgba(0, 0, 0, 0.85)'
  ctx.shadowBlur = 12
  ctx.shadowOffsetY = 2
  ctx.letterSpacing = '0.08em'

  const textWidth = ctx.measureText(watermarkText).width
  const textHeight = fontSize * 1.15
  const padX = Math.max(12, drawWidth * 0.03)
  const padY = Math.max(12, drawHeight * 0.03)
  const minX = offsetX + padX
  const maxX = offsetX + drawWidth - textWidth - padX
  const minY = offsetY + padY
  const maxY = offsetY + drawHeight - textHeight - padY
  const textX = minX + Math.max(0, maxX - minX) * x
  const textY = minY + Math.max(0, maxY - minY) * y

  ctx.fillText(watermarkText, textX, textY)
  ctx.restore()
}
