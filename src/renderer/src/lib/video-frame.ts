/** Seconds for one full loop of the watermark path. */
export const WATERMARK_DURATION_S = 24

const WATERMARK_KEYFRAMES: Array<{ t: number; x: number; y: number }> = [
  { t: 0, x: 0.08, y: 0.12 },
  { t: 0.2, x: 0.78, y: 0.18 },
  { t: 0.4, x: 0.82, y: 0.72 },
  { t: 0.6, x: 0.42, y: 0.82 },
  { t: 0.8, x: 0.12, y: 0.58 },
  { t: 1, x: 0.08, y: 0.12 }
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
  ctx.shadowColor = 'rgba(0, 0, 0, 0.85)'
  ctx.shadowBlur = 12
  ctx.shadowOffsetY = 2
  ctx.letterSpacing = '0.08em'
  ctx.fillText(watermarkText, offsetX + drawWidth * x, offsetY + drawHeight * y)
  ctx.restore()
}
