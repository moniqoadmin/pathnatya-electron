import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Account } from './api/accounts'
import { postAppLog, reportAppLog, type AppLogEvent } from './api/logs'
import { clearHlsPlayback } from './lib/hls-loader'
import { clearAllStorage } from './lib/storage'
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/LoginPage'
import PhoneCheckPage from './pages/PhoneCheckPage'
import PreparingVideoPage from './pages/PreparingVideoPage'
import SetPasswordPage from './pages/SetPasswordPage'
import VideoLoaderPage from './pages/VideoLoaderPage'
import TamperWarning from './components/TamperWarning'

type Page = 'landing' | 'phone-check' | 'set-password' | 'login' | 'preparing' | 'video'

const SESSION_TIMEOUT_MS = 60 * 60 * 1000

/** How long the "delete the duplicate copy" warning stays up before the forced logout. */
const TAMPER_WARNING_SECONDS = 10

const APP_LOG_EVENTS = new Set<AppLogEvent>([
  'DEVTOOLS_SHORTCUT',
  'DEVTOOLS_OPENED',
  'FILES_TAMPERED'
])

export default function App() {
  const [page, setPage] = useState<Page>('landing')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [account, setAccount] = useState<Account | null>(null)
  const [phoneCheckResetKey, setPhoneCheckResetKey] = useState(0)
  const [tamperedLocations, setTamperedLocations] = useState<string[] | null>(null)
  const filesTamperedReportedRef = useRef(false)
  const filesTamperedRequestRef = useRef(false)
  const virtualMachineRef = useRef(false)

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
