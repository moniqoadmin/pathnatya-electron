import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Account } from './api/accounts'
import { fetchServerVersion, isNewerVersion } from './api/health'
import { postAppLog, reportAppLog, type AppLogEvent } from './api/logs'
import { startConnectivityWatch } from './lib/connectivity'
import { startOfflineCheckInWatch } from './lib/offline-checkin-watch'
import { startTrustedTimeDailyWatch } from './lib/trusted-time-watch'
import { clearHlsMemoryVideo, clearHlsPlayback, wipeDownloadedVideo } from './lib/hls-loader'
import { isOffline } from './lib/network'
import { clearAllStorage, getSession } from './lib/storage'
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/LoginPage'
import PermissionsPage from './pages/PermissionsPage'
import PhoneCheckPage from './pages/PhoneCheckPage'
import PreparingVideoPage from './pages/PreparingVideoPage'
import SetPasswordPage from './pages/SetPasswordPage'
import UpdateRequiredPage from './pages/UpdateRequiredPage'
import VideoLoaderPage from './pages/VideoLoaderPage'
import TamperWarning from './components/TamperWarning'
import AlwaysOnTopGate from './components/AlwaysOnTopGate'
import type { AppPermissionsStatus, PermissionId } from './env'

type Page = 'landing' | 'phone-check' | 'set-password' | 'login' | 'preparing' | 'video'

const SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000

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

/** One /logs attempt while the session token is still valid. */
async function sendFilesTamperedLog(getToken: () => string | null): Promise<boolean> {
  const token = getToken()
  if (!token || isOffline()) {
    return false
  }

  try {
    return await postAppLog('FILES_TAMPERED', true, token, {
      timeoutMs: 8_000,
      retries: 0
    })
  } catch (error) {
    console.error('Unable to report FILES_TAMPERED log:', error)
    return false
  }
}

/** Persist the lock file only when /logs did not accept FILES_TAMPERED. */
async function persistTamperLockIfLogsFailed(sent: boolean): Promise<void> {
  if (sent) {
    return
  }

  try {
    await window.pathnatya.markVideoTampered()
  } catch (error) {
    console.error('Unable to write video tamper lock:', error)
  }
}

export default function App() {
  const [permissions, setPermissions] = useState<AppPermissionsStatus | null>(null)
  const [permissionsChecking, setPermissionsChecking] = useState(true)
  const [updateRequired, setUpdateRequired] = useState(false)
  const [versionChecked, setVersionChecked] = useState(false)
  const [page, setPage] = useState<Page>('landing')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [account, setAccount] = useState<Account | null>(null)
  const [phoneCheckResetKey, setPhoneCheckResetKey] = useState(0)
  const [tamperedLocations, setTamperedLocations] = useState<string[] | null>(null)
  const [alwaysOnTopBlocked, setAlwaysOnTopBlocked] = useState(false)
  const [alwaysOnTopWindows, setAlwaysOnTopWindows] = useState<string[]>([])
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
    let cancelled = false

    void (async () => {
      try {
        const [current, remote] = await Promise.all([
          window.pathnatya.getVersion(),
          fetchServerVersion()
        ])
        // remote comes from the main-process /health/time sync (same payload as /health).
        if (!cancelled && remote && isNewerVersion(remote, current)) {
          setUpdateRequired(true)
        }
      } catch (error) {
        console.error('Unable to check app version:', error)
      } finally {
        if (!cancelled) {
          setVersionChecked(true)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

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

  // OS online/offline only. GET /health/time uses the same 24h Cloudflare tick as play logs.
  useEffect(() => {
    const stopConnectivity = startConnectivityWatch()
    const stopTrustedTime = startTrustedTimeDailyWatch()
    return () => {
      stopConnectivity()
      stopTrustedTime()
    }
  }, [])

  // Block the whole app (login included) when another window is pinned always-on-top.
  useEffect(() => {
    const apply = (state: {
      active: boolean
      appName: string
      reason: '' | 'recorder' | 'virtual-machine' | 'clock-mismatch' | 'always-on-top'
      windows?: string[]
    }): void => {
      const blocked = state.active && state.reason === 'always-on-top'
      setAlwaysOnTopBlocked(blocked)
      setAlwaysOnTopWindows(
        blocked ? (state.windows?.length ? state.windows : state.appName ? [state.appName] : []) : []
      )

      if (blocked) {
        if (!alwaysOnTopReportedRef.current) {
          alwaysOnTopReportedRef.current = true
          reportAppLog('ALWAYS_ON_TOP_DETECTED', true)
        }
      } else if (alwaysOnTopReportedRef.current) {
        alwaysOnTopReportedRef.current = false
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
        const token = authTokenRef.current ?? getSession()?.token ?? null
        if (!token) {
          // No session → cannot POST /logs; keep the lock for the next online login.
          void persistTamperLockIfLogsFailed(false)
          return
        }

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
  // One /logs attempt; lock file is written only when that attempt fails.
  useEffect(() => {
    if (tamperedLocations === null) {
      return
    }

    const pending = (async () => {
      const sent = await sendFilesTamperedLog(
        () => authTokenRef.current ?? getSession()?.token ?? null
      )
      await persistTamperLockIfLogsFailed(sent)
    })()

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

  // Every 5 minutes: if the 2-day check-in window has passed, end the session
  // so the user must log in again. Downloaded video is left on disk.
  useEffect(() => {
    if (!account) {
      return
    }

    return startOfflineCheckInWatch({
      onRequired: () => {
        clearAllStorage()
        handleLogout()
      }
    })
  }, [account, handleLogout])

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
      if (id === 'accessibility') {
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

  if ((permissionsChecking && !permissions) || !versionChecked) {
    return (
      <>
        <div className="page permissions-page">
          <header className="page-header">
            <p className="sanskrit-header">Jay Yogeshwar</p>
            <h1>Pathnatya 2026</h1>
            <p className="page-subtitle">Checking permissions…</p>
          </header>
        </div>
        {alwaysOnTopBlocked && <AlwaysOnTopGate windows={alwaysOnTopWindows} />}
      </>
    )
  }

  if (updateRequired) {
    return (
      <>
        <UpdateRequiredPage />
        {alwaysOnTopBlocked && <AlwaysOnTopGate windows={alwaysOnTopWindows} />}
      </>
    )
  }

  // Block the whole app until required OS permissions are granted.
  const permissionBlocked =
    !permissions ||
    !permissions.allRequiredGranted ||
    permissions.permissions.some((item) => item.required && !item.granted)

  if (permissionBlocked) {
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
        {alwaysOnTopBlocked && <AlwaysOnTopGate windows={alwaysOnTopWindows} />}
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
        onTamperLogout={() => {
          // Skip wipeDownloadedVideo — package was already cleared at tamper time.
          clearHlsPlayback()
          clearAllStorage()
          authTokenRef.current = null
          setAccount(null)
          setPhoneNumber('')
          setPage('landing')
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
      {alwaysOnTopBlocked && <AlwaysOnTopGate windows={alwaysOnTopWindows} />}
      {tamperedLocations !== null && (
        <TamperWarning locations={tamperedLocations} seconds={TAMPER_WARNING_SECONDS} />
      )}
    </>
  )
}
