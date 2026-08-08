import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Account } from './api/accounts'
import OfflineToast from './components/OfflineToast'
import { clearHlsPlayback } from './lib/hls-loader'
import { clearAllStorage } from './lib/storage'
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/LoginPage'
import PhoneCheckPage from './pages/PhoneCheckPage'
import SetPasswordPage from './pages/SetPasswordPage'
import VideoLoaderPage from './pages/VideoLoaderPage'

type Page = 'landing' | 'phone-check' | 'set-password' | 'login' | 'video'

const SESSION_TIMEOUT_MS = 60 * 60 * 1000

export default function App() {
  const [page, setPage] = useState<Page>('landing')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [account, setAccount] = useState<Account | null>(null)

  useEffect(() => {
    clearAllStorage()
    clearHlsPlayback()
  }, [])

  const handleLogout = useCallback(() => {
    setAccount(null)
    setPhoneNumber('')
    setPage('landing')
  }, [])

  let content: ReactNode

  if (page === 'landing') {
    content = <LandingPage onContinue={() => setPage('phone-check')} />
  } else if (page === 'phone-check') {
    content = (
      <PhoneCheckPage
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
          setPage('video')
        }}
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
      <OfflineToast />
    </>
  )
}
