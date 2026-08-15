import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Account } from './api/accounts'
import { postAppLog, reportAppLog, type AppLogEvent } from './api/logs'
import { clearHlsPlayback } from './lib/hls-loader'
import { clearAllStorage } from './lib/storage'
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/LoginPage'
import PermissionsPage from './pages/PermissionsPage'
import PhoneCheckPage from './pages/PhoneCheckPage'
import PreparingVideoPage from './pages/PreparingVideoPage'
import SetPasswordPage from './pages/SetPasswordPage'
import VideoLoaderPage from './pages/VideoLoaderPage'
import TamperWarning from './components/TamperWarning'
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

export default function App() {
  const [permissions, setPermissions] = useState<AppPermissionsStatus | null>(null)
  const [permissionsChecking, setPermissionsChecking] = useState(true)
  const [page, setPage] = useState<Page>('landing')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [account, setAccount] = useState<Account | null>(null)
  const [phoneCheckResetKey, setPhoneCheckResetKey] = useState(0)
  const [tamperedLocations, setTamperedLocations] = useState<string[] | null>(null)
  const filesTamperedReportedRef = useRef(false)
  const filesTamperedRequestRef = useRef(false)
  const virtualMachineRef = useRef(false)

  const refreshPermissions = useCallback(async (options?: { silent?: boolean }) => {
    const silent = Boolean(options?.silent)
    if (!silent) {
      setPermissionsChecking(true)
    }

    try {
      const status = await window.pathnatya.getAppPermissions()
      setPermissions(status)
    } catch (error) {
      console.error('Unable to read app permissions:', error)
      // Fail closed: keep the gate up with an empty denied checklist.
      setPermissions({
        platform: 'other',
        allRequiredGranted: false,
        permissions: []
      })
    } finally {
      if (!silent) {
        setPermissionsChecking(false)
      }
    }
  }, [])

  useEffect(() => {
    void refreshPermissions()

    const intervalId = window.setInterval(() => {
      void refreshPermissions({ silent: true })
    }, PERMISSIONS_POLL_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [refreshPermissions])

  useEffect(() => {
    clearAllStorage()
    clearHlsPlayback()
  }, [])

  // Main settles this before the window opens, so it is known well before login.
  useEffect(() => {
    void window.pathnatya.getVmState().then((state) => {
      virtualMachineRef.current = state.virtual
    })
  }, [])

  useEffect(() => {
    return window.pathnatya.onResetToLogin(() => {
      clearHlsPlayback()
      clearAllStorage()
      setAccount(null)
      setPhoneNumber('')
      setPhoneCheckResetKey((key) => key + 1)
      setPage('phone-check')
    })
  }, [])

  // Streaming drive scan runs only when login returned chokidar: true.
  useEffect(() => {
    void window.pathnatya.setDriveScanEnabled(Boolean(account?.chokidar))
  }, [account])

  const forceLogout = useCallback(() => {
    clearHlsPlayback()
    clearAllStorage()
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
        // Keeps the first reported pair so a later scan hit cannot restart the countdown.
        const locations =
          paths && paths.length > 0 ? paths : path ? [path] : []
        setTamperedLocations((current) => current ?? locations)

        if (filesTamperedReportedRef.current || filesTamperedRequestRef.current) {
          return
        }

        filesTamperedRequestRef.current = true
        void postAppLog('FILES_TAMPERED', true)
          .then((sent) => {
            filesTamperedReportedRef.current = sent
          })
          .catch((error) => {
            console.error('Unable to report FILES_TAMPERED log:', error)
          })
          .finally(() => {
            filesTamperedRequestRef.current = false
          })
        return
      }

      reportAppLog(event as AppLogEvent, tampered)
    })
  }, [])

  // The warning names both folder locations, then the session ends whether or not the copy was deleted.
  useEffect(() => {
    if (tamperedLocations === null) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setTamperedLocations(null)
      forceLogout()
    }, TAMPER_WARNING_SECONDS * 1000)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [tamperedLocations, forceLogout])

  const handleLogout = useCallback(() => {
    setAccount(null)
    setPhoneNumber('')
    setPage('landing')
  }, [])

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

  if (permissionsChecking && !permissions) {
    return (
      <div className="page permissions-page">
        <header className="page-header">
          <p className="sanskrit-header">Jay Yogeshwar</p>
          <h1>Pathnatya 2026</h1>
          <p className="page-subtitle">Checking permissions…</p>
        </header>
      </div>
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
      <PermissionsPage
        status={gateStatus}
        checking={permissionsChecking}
        onRecheck={() => {
          void refreshPermissions()
        }}
        onOpenSettings={(id) => {
          void handleOpenPermissionSettings(id)
        }}
      />
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
          setAccount(loggedInAccount)
          // Downloading is refused on a VM, so skip straight to the player, where
          // the gate explains why nothing will play.
          const canPrepare = loggedInAccount.isOffline && !virtualMachineRef.current
          setPage(canPrepare ? 'preparing' : 'video')
        }}
      />
    )
  } else if (page === 'preparing' && account) {
    content = <PreparingVideoPage onReady={handleVideoReady} onLogout={handleLogout} />
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
      {tamperedLocations !== null && (
        <TamperWarning locations={tamperedLocations} seconds={TAMPER_WARNING_SECONDS} />
      )}
    </>
  )
}
