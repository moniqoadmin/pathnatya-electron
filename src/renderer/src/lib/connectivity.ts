import { useEffect, useState } from 'react'

export type Connectivity = 'online' | 'offline' | 'unknown'

let state: Connectivity = 'unknown'
let watchers = 0

const listeners = new Set<(next: Connectivity) => void>()

function setState(next: Connectivity): void {
  if (state === next) {
    return
  }

  state = next
  for (const listener of listeners) {
    listener(next)
  }
}

export function getConnectivity(): Connectivity {
  return state
}

export function subscribeConnectivity(listener: (next: Connectivity) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Record what real API traffic just observed, so gating reacts without a background probe. */
export function reportNetworkSuccess(): void {
  setState('online')
}

export function reportNetworkFailure(): void {
  setState('offline')
}

/**
 * True when the OS reports a network interface. Does not call the server —
 * login / phone-check use the real request, and a failure falls through to offline.
 */
export async function ensureOnline(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setState('offline')
    return false
  }

  return true
}

function onBrowserOffline(): void {
  setState('offline')
}

function onBrowserOnline(): void {
  // Browser only knows the link is up. Stay unknown until a real API succeeds
  // so we do not fire health/time probes or treat a captive portal as online.
  if (state === 'offline') {
    setState('unknown')
  }
}

function applyNavigatorState(): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setState('offline')
  }
}

/**
 * Watch OS online/offline events only. No health or time polling.
 */
export function startConnectivityWatch(): () => void {
  watchers += 1

  if (watchers === 1) {
    applyNavigatorState()
    window.addEventListener('offline', onBrowserOffline)
    window.addEventListener('online', onBrowserOnline)
  }

  let stopped = false

  return () => {
    if (stopped) {
      return
    }

    stopped = true
    watchers -= 1
    if (watchers > 0) {
      return
    }

    window.removeEventListener('offline', onBrowserOffline)
    window.removeEventListener('online', onBrowserOnline)
  }
}

export function useConnectivity(): Connectivity {
  const [current, setCurrent] = useState<Connectivity>(getConnectivity)

  useEffect(() => {
    setCurrent(getConnectivity())
    return subscribeConnectivity(setCurrent)
  }, [])

  return current
}
