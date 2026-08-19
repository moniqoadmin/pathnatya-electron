import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Account } from './api/accounts'
import { postAppLog, reportAppLog, type AppLogEvent } from './api/logs'
import { startConnectivityWatch, subscribeConnectivity } from './lib/connectivity'
import { clearHlsMemoryVideo, clearHlsPlayback, wipeDownloadedVideo } from './lib/hls-loader'
import { clearAllStorage, getSession } from './lib/storage'
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/LoginPage'
import PermissionsPage from './pages/PermissionsPage'
import PhoneCheckPage from './pages/PhoneCheckPage'
import PreparingVideoPage from './pages/PreparingVideoPage'
import SetPasswordPage from './pages/SetPasswordPage'
import VideoLoaderPage from './pages/VideoLoaderPage'
import TamperWarning from './components/TamperWarning'
import AlwaysOnTopGate from './components/AlwaysOnTopGate'
import type { AppPermissionsStatus, PermissionId } from './env'

type Page = 'landing' | 'phone-check' | 'set-password' | 'login' | 'preparing' | 'video'

const SESSION_TIMEOUT_MS = 60 * 60 * 1000

/** Re-check OS permissions on this interval so revoked grants re-open the gate. */
const PERMISSIONS_POLL_MS = 60 * 1000

/** How long the "delete the duplicate copy" warning stays up before the forced logout. */
const TAMPER_WARNING_SECONDS = 10

const APP_LOG_EVENTS = new Set<AppLogEvent>([
  'DEVTOOLS_SHORTCUT',
  'DEVTOOLS_OPENED',
  'FILES_TAMPERED'
])

/** Renderer in-memory session is empty on a fresh process; only purge once so HMR remounts keep the token. */
let didPurgeRendererSession = false

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

/** Keep posting FILES_TAMPERED until /logs accepts it or the warning window ends. */
async function sendFilesTamperedLog(getToken: () => string | null): Promise<boolean> {
  const deadline = Date.now() + TAMPER_WARNING_SECONDS * 1000
  let delay = 0

  while (Date.now() <= deadline) {
    if (delay > 0) {
      await sleep(delay)
    }

    const token = getToken()
    if (token) {
      try {
        const sent = await postAppLog('FILES_TAMPERED', true, token, {
          timeoutMs: 8_000,
          retries: 0
        })
        if (sent) {
          return true
        }
      } catch (error) {
        console.error('Unable to report FILES_TAMPERED log:', error)
      }
    }

    delay = delay === 0 ? 400 : Math.min(delay * 2, 2_000)
  }

  console.warn('Unable to report FILES_TAMPERED log: no successful /logs call')
  return false
}

export default function App() {
  const [permissions, setPermissions] = useState<AppPermissionsStatus | null>(null)
  const [permissionsChecking, setPermissionsChecking] = useState(true)
  const [page, setPage] = useState<Page>('landing')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [account, setAccount] = useState<Account | null>(null)
  const [phoneCheckResetKey, setPhoneCheckResetKey] = useState(0)
  const [tamperedLocations, setTamperedLocations] = useState<string[] | null>(null)
  const [alwaysOnTopBlocked, setAlwaysOnTopBlocked] = useState(false)
  const authTokenRef = useRef<string | null>(null)
  const alwaysOnTopReportedRef = useRef(false)
  const virtualMachineRef = useRef(false)
  const clockMismatchedRef = useRef(false)

  const refreshPermissions = useCallback(async (options?: { silent?: boolean }) => {
    const silent = Boolean(options?.silent)
    if (!silent) {
      setPermissionsChecking(true)
    }

    try {
      const status = await window.pathnatya.getAppPermissions()
      setPermissions(status)
      return status
    } catch (error) {
      console.error('Unable to read app permissions:', error)
      // Fail closed: keep the gate up with an empty denied checklist.
      const denied: AppPermissionsStatus = {
        platform: 'other',
        allRequiredGranted: false,
        permissions: []
      }
      setPermissions(denied)
      return denied
    } finally {
      if (!silent) {
        setPermissionsChecking(false)
      }
    }
  }, [])

  useEffect(() => {
    void refreshPermissions()
  }, [refreshPermissions])

  useEffect(() => {
    const granted = Boolean(permissions?.allRequiredGranted)
    const intervalId = window.setInterval(() => {
      void refreshPermissions({ silent: true })
    }, granted ? PERMISSIONS_POLL_MS : 5_000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [refreshPermissions, permissions?.allRequiredGranted])

  useEffect(() => {
    const onFocus = (): void => {
      if (!permissions?.allRequiredGranted) {
        void refreshPermissions({ silent: true })
      }
    }

    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
    }
  }, [permissions?.allRequiredGranted, refreshPermissions])

  useEffect(() => {
    if (didPurgeRendererSession) {
      return
    }
    didPurgeRendererSession = true
    clearAllStorage()
    clearHlsPlayback()
  }, [])

  // Runs for the life of the app so login already knows whether the server is reachable.
  // Coming back online resyncs trusted time, drops reboot penalties, and keeps a
  // still-valid 2-day check-in expiry (a lapsed window is restamped from server GMT).
  useEffect(() => {
    const unsubscribe = subscribeConnectivity((next) => {
      if (next === 'online') {
        void window.pathnatya.renewOfflineCheckIn()
      }
    })
    const stopWatch = startConnectivityWatch()
    return () => {
      unsubscribe()
      stopWatch()
    }
  }, [])

  // Block the whole app (login included) when another window is pinned always-on-top.
  useEffect(() => {
    const apply = (state: {
      active: boolean
      reason: '' | 'recorder' | 'virtual-machine' | 'clock-mismatch' | 'always-on-top'
    }): void => {
      const blocked = state.active && state.reason === 'always-on-top'
      setAlwaysOnTopBlocked(blocked)

      if (blocked) {
        if (!alwaysOnTopReportedRef.current) {
          alwaysOnTopReportedRef.current = true
          reportAppLog('ALWAYS_ON_TOP_DETECTED', true)
        }
      } else if (alwaysOnTopReportedRef.current) {
        alwaysOnTopReportedRef.current = false
        reportAppLog('ALWAYS_ON_TOP_CLEARED', false)
      }
    }

    void window.pathnatya.getScreenCaptureState().then(apply)
    return window.pathnatya.onScreenCaptureChanged(apply)
  }, [])

  // Main settles these before the window opens, so they are known well before login.
  useEffect(() => {
    void window.pathnatya.getVmState().then((state) => {
      virtualMachineRef.current = state.virtual
    })
    void window.pathnatya.getClockSkewState().then((state) => {
      clockMismatchedRef.current = state.mismatched
    })
  }, [])

  useEffect(() => {
    return window.pathnatya.onResetToLogin(() => {
      clearHlsPlayback()
      clearHlsMemoryVideo()
      clearAllStorage()
      setAccount(null)
      setPhoneNumber('')
      setPhoneCheckResetKey((key) => key + 1)
      setPage('phone-check')
    })
  }, [])

  // Streaming drive scan runs whenever a session is active.
  useEffect(() => {
    void window.pathnatya.setDriveScanEnabled(Boolean(account))
    if (account) {
      authTokenRef.current = getSession()?.token ?? authTokenRef.current
    }
  }, [account])

  const forceLogout = useCallback(() => {
    clearHlsPlayback()
    wipeDownloadedVideo()
    clearAllStorage()
    authTokenRef.current = null
    setAccount(null)
    setPhoneNumber('')
    setPage('landing')
  }, [])

  useEffect(() => {
    return window.pathnatya.onAppLog(({ event, tampered, path, paths }) => {
      if (!APP_LOG_EVENTS.has(event as AppLogEvent)) {
        return
      }

      if (event === 'FILES_TAMPERED') {
        // Keeps the first reported location so a later scan hit cannot restart the countdown.
        const locations =
          paths && paths.length > 0 ? paths : path ? [path] : []
        setTamperedLocations((current) => current ?? locations)
        return
      }

      reportAppLog(event as AppLogEvent, tampered)
    })
  }, [])

  // The warning names the folder the copy was found in, then the session ends.
  // Showing 6924 always starts /logs; logout waits so the token is not wiped mid-post.
  useEffect(() => {
    if (tamperedLocations === null) {
      return
    }

    const pending = sendFilesTamperedLog(
      () => authTokenRef.current ?? getSession()?.token ?? null
    )

    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          await pending
        } finally {
          setTamperedLocations(null)
          forceLogout()
        }
      })()
    }, TAMPER_WARNING_SECONDS * 1000)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [tamperedLocations, forceLogout])

  const handleLogout = useCallback(() => {
    // Keep the in-memory video package; only drop the active playback session.
    clearHlsPlayback()
    setAccount(null)
    setPhoneNumber('')
    setPage('landing')
  }, [])

  useEffect(() => {
    const subscribe = window.pathnatya.onLogoutShortcut
    if (typeof subscribe !== 'function') {
      return
    }

    return subscribe(() => {
      handleLogout()
    })
  }, [handleLogout])

  const handleVideoReady = useCallback(() => {
    setPage('video')
  }, [])

  const handleOpenPermissionSettings = useCallback(async (id?: PermissionId) => {
    try {
      if (id === 'accessibility' || id === undefined) {
        await window.pathnatya.requestAccessibilityPermission()
      }
      await window.pathnatya.openPermissionSettings(id)
    } catch (error) {
      console.error('Unable to open permission settings:', error)
    }
  }, [])

  const handleRelaunchApp = useCallback(() => {
    void window.pathnatya.relaunchApp()
  }, [])

  if (permissionsChecking && !permissions) {
    return (
      <>
        <div className="page permissions-page">
          <header className="page-header">
            <p className="sanskrit-header">Jay Yogeshwar</p>
            <h1>Pathnatya 2026</h1>
            <p className="page-subtitle">Checking permissions…</p>
          </header>
        </div>
        {alwaysOnTopBlocked && <AlwaysOnTopGate />}
      </>
    )
  }

  // Block the whole app until required OS permissions are granted.
  if (!permissions || !permissions.allRequiredGranted) {
    const gateStatus: AppPermissionsStatus = permissions ?? {
      platform: 'other',
      allRequiredGranted: false,
      permissions: []
    }

    return (
      <>
        <PermissionsPage
          status={gateStatus}
          checking={permissionsChecking}
          onRecheck={() => {
            void refreshPermissions()
          }}
          onOpenSettings={(id) => {
            void handleOpenPermissionSettings(id)
          }}
          onRelaunch={handleRelaunchApp}
        />
        {alwaysOnTopBlocked && <AlwaysOnTopGate />}
      </>
    )
  }

  let content: ReactNode

  if (page === 'landing') {
    content = <LandingPage onContinue={() => setPage('phone-check')} />
  } else if (page === 'phone-check') {
    content = (
      <PhoneCheckPage
        key={phoneCheckResetKey}
        onBack={() => setPage('landing')}
        onExistingAccount={(phone) => {
          setPhoneNumber(phone)
          setPage('login')
        }}
        onNeedsPassword={(phone) => {
          setPhoneNumber(phone)
          setPage('set-password')
        }}
      />
    )
  } else if (page === 'set-password') {
    content = (
      <SetPasswordPage
        phoneNumber={phoneNumber}
        onBack={() => {
          setPhoneNumber('')
          setPage('phone-check')
        }}
        onSuccess={() => setPage('login')}
      />
    )
  } else if (page === 'login') {
    content = (
      <LoginPage
        phoneNumber={phoneNumber}
        onBack={() => {
          setPhoneNumber('')
          setPage('phone-check')
        }}
        onSuccess={(loggedInAccount) => {
          authTokenRef.current = getSession()?.token ?? authTokenRef.current
          setAccount(loggedInAccount)
          // Re-read clock skew in case the user changed the system time while
          // sitting on the login screen after a clean startup sync.
          void window.pathnatya
            .getClockSkewState()
            .then((clock) => {
              clockMismatchedRef.current = clock.mismatched
              // Offline → disk package; online → full video into RAM. Skip prepare
              // only when video itself is blocked (VM / clock).
              const canPrepare = !virtualMachineRef.current && !clock.mismatched
              setPage(canPrepare ? 'preparing' : 'video')
            })
            .catch(() => {
              const canPrepare =
                !virtualMachineRef.current && !clockMismatchedRef.current
              setPage(canPrepare ? 'preparing' : 'video')
            })
        }}
      />
    )
  } else if (page === 'preparing' && account) {
    content = (
      <PreparingVideoPage
        storage={account.isOffline ? 'disk' : 'memory'}
        showLogoutButton={account.logoutButton === true}
        onReady={handleVideoReady}
        onLogout={handleLogout}
      />
    )
  } else if (account) {
    content = (
      <VideoLoaderPage
        account={account}
        sessionTimeoutMs={SESSION_TIMEOUT_MS}
        onLogout={handleLogout}
      />
    )
  } else {
    content = <LandingPage onContinue={() => setPage('phone-check')} />
  }

  return (
    <>
      {content}
      {alwaysOnTopBlocked && <AlwaysOnTopGate />}
      {tamperedLocations !== null && (
        <TamperWarning locations={tamperedLocations} seconds={TAMPER_WARNING_SECONDS} />
      )}
    </>
  )
}
