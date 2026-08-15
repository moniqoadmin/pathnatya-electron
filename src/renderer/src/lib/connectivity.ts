import { useEffect, useState } from 'react'
import { API_BASE, APP_KEY } from '../api/config'

export type Connectivity = 'online' | 'offline' | 'unknown'

/** Tiny unauthenticated endpoint (~60 bytes) already used for trusted time. */
const HEALTH_PATH = '/health/time'
/** Steady-state cadence once the server answers. */
const ONLINE_POLL_MS = 20_000
/** Faster while down so the app returns to online mode quickly. */
const OFFLINE_POLL_MS = 5000
/** A reachable server answers well inside this; keeps login snappy. */
const PROBE_TIMEOUT_MS = 4000
/** How long a probe result is trusted before callers force a fresh one. */
const FRESH_MS = 3000

let state: Connectivity = 'unknown'
let lastCheckedAt = 0
let inflight: Promise<boolean> | null = null
let timeoutId = 0
let watchers = 0

const listeners = new Set<(next: Connectivity) => void>()

function setState(next: Connectivity): void {
  lastCheckedAt = Date.now()

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

/** Record what real API traffic just observed, so gating reacts without waiting for a poll. */
export function reportNetworkSuccess(): void {
  setState('online')
}

export function reportNetworkFailure(): void {
  setState('offline')
}

async function runProbe(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setState('offline')
    return false
  }

  const controller = new AbortController()
  const abortId = window.setTimeout(() => {
    controller.abort()
  }, PROBE_TIMEOUT_MS)

  try {
    const response = await fetch(`${API_BASE}${HEALTH_PATH}`, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json', 'X-App-Key': APP_KEY },
      signal: controller.signal
    })

    setState(response.ok ? 'online' : 'offline')
    return response.ok
  } catch {
    setState('offline')
    return false
  } finally {
    window.clearTimeout(abortId)
  }
}

/** Probe the server now, sharing one request between concurrent callers. */
export function probeConnectivity(): Promise<boolean> {
  if (!inflight) {
    inflight = runProbe().finally(() => {
      inflight = null
    })
  }

  return inflight
}

/**
 * True when the server is reachable. Reuses a very recent probe so the login
 * screen does not add a round-trip, and probes when the answer is stale.
 */
export async function ensureOnline(): Promise<boolean> {
  if (state !== 'unknown' && Date.now() - lastCheckedAt < FRESH_MS) {
    return state === 'online'
  }

  return probeConnectivity()
}

function schedule(): void {
  window.clearTimeout(timeoutId)
  timeoutId = window.setTimeout(tick, state === 'online' ? ONLINE_POLL_MS : OFFLINE_POLL_MS)
}

function tick(): void {
  void probeConnectivity().finally(schedule)
}

function onBrowserOffline(): void {
  setState('offline')
  schedule()
}

function onBrowserOnline(): void {
  tick()
}

/**
 * Poll the health endpoint for as long as the app is open. Login can then switch
 * straight to offline mode instead of discovering it through failed auth calls.
 */
export function startConnectivityWatch(): () => void {
  watchers += 1

  if (watchers === 1) {
    window.addEventListener('offline', onBrowserOffline)
    window.addEventListener('online', onBrowserOnline)
    tick()
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

    window.clearTimeout(timeoutId)
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
