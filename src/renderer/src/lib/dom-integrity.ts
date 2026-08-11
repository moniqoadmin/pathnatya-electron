/**
 * Watches the video-player subtree for unexpected DOM edits (injected nodes,
 * forbidden tags, or removal of the protected video/canvas). React-owned
 * controls and status UI are allowlisted so normal playback updates stay quiet.
 */

const FORBIDDEN_TAGS = new Set([
  'SCRIPT',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'LINK',
  'META',
  'BASE',
  'FORM'
])

const PROTECTED_SELECTORS = ['video.source-video', 'canvas.video-canvas'] as const

function hasClass(el: Element, name: string): boolean {
  return el.classList.contains(name)
}

function isSvgFamily(el: Element): boolean {
  return el.namespaceURI === 'http://www.w3.org/2000/svg' || el.closest('svg') !== null
}

/** True when the element matches the known React-rendered player UI. */
function isAllowedElement(el: Element): boolean {
  if (isSvgFamily(el)) {
    return true
  }

  const tag = el.tagName

  if (FORBIDDEN_TAGS.has(tag)) {
    return false
  }

  switch (tag) {
    case 'P':
      return (
        hasClass(el, 'video-status') ||
        hasClass(el, 'form-error') ||
        hasClass(el, 'video-fullscreen-gate-text') ||
        hasClass(el, 'video-capture-app') ||
        hasClass(el, 'video-fullscreen-gate-hint')
      )
    case 'VIDEO':
      return hasClass(el, 'source-video')
    case 'CANVAS':
      return hasClass(el, 'video-canvas')
    case 'DIV':
      return (
        hasClass(el, 'video-controls') ||
        hasClass(el, 'video-seek-wrap') ||
        hasClass(el, 'video-volume-control') ||
        hasClass(el, 'video-volume-popup') ||
        hasClass(el, 'video-fullscreen-gate')
      )
    case 'BUTTON':
      return (
        hasClass(el, 'video-control-btn') ||
        hasClass(el, 'video-scene-marker') ||
        hasClass(el, 'video-fullscreen-gate-btn')
      )
    case 'INPUT':
      return hasClass(el, 'video-seek') || hasClass(el, 'video-volume-slider')
    case 'SPAN':
      return hasClass(el, 'video-time') || hasClass(el, 'video-fullscreen-gate-lock')
    case 'SOURCE':
      // Some players attach <source> under <video>; treat as expected.
      return el.parentElement?.tagName === 'VIDEO'
    default:
      return false
  }
}

function subtreeHasUnexpectedNode(node: Node): boolean {
  if (!(node instanceof Element)) {
    return false
  }

  if (!isAllowedElement(node)) {
    return true
  }

  for (const child of node.querySelectorAll('*')) {
    if (!isAllowedElement(child)) {
      return true
    }
  }

  return false
}

function protectedVideoMissing(root: Element): boolean {
  return !root.querySelector('video.source-video')
}

/**
 * hls.js drives playback through MSE, so it legitimately points the video at a
 * same-origin `blob:` URL (and clears it on destroy). A file, http, or remote
 * source means something outside the app rewired the player.
 */
function isAllowedMediaSrc(value: string | null): boolean {
  if (!value) {
    return true
  }

  return value.startsWith(`blob:${location.origin}/`) || value.startsWith('pathnatya://hls/')
}

function isTamperedAttribute(el: Element, attributeName: string | null): boolean {
  switch (attributeName) {
    case 'src':
      return !isAllowedMediaSrc(el.getAttribute('src'))
    case 'controls':
      // Native controls expose a download button, so they must stay off.
      return el.hasAttribute('controls')
    case 'controlslist':
      return !(el.getAttribute('controlslist') ?? '').includes('nodownload')
    default:
      return false
  }
}

export type DomIntegrityOptions = {
  /** Whether the watermark canvas is currently expected to be mounted. */
  isCanvasExpected: () => boolean
  onTampered: () => void
}

/**
 * Observe `root` for unexpected mutations. Returns a disposer.
 * `onTampered` is invoked at most once per observer lifetime.
 */
export function watchVideoPlayerDom(root: Element, options: DomIntegrityOptions): () => void {
  let reported = false

  const report = (): void => {
    if (reported) {
      return
    }
    reported = true
    options.onTampered()
  }

  const observer = new MutationObserver((mutations) => {
    if (reported) {
      return
    }

    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const added of mutation.addedNodes) {
          if (subtreeHasUnexpectedNode(added)) {
            report()
            return
          }
        }

        const canvasMissing =
          options.isCanvasExpected() && !root.querySelector('canvas.video-canvas')

        if (protectedVideoMissing(root) || canvasMissing) {
          report()
          return
        }
      }

      if (
        mutation.type === 'attributes' &&
        mutation.target instanceof Element &&
        mutation.target.matches(PROTECTED_SELECTORS.join(',')) &&
        isTamperedAttribute(mutation.target, mutation.attributeName)
      ) {
        report()
        return
      }
    }
  })

  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'controls', 'controlslist']
  })

  return () => {
    observer.disconnect()
  }
}
