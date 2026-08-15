import { FormEvent, useState } from 'react'
import { getLoginTokens as fetchLoginTokens, login } from '../api/accounts'
import { saveLoginTokens, saveSession } from '../lib/storage'
import { ensureOnline } from '../lib/connectivity'
import { isNetworkError, isOffline } from '../lib/network'
import { getDeviceId } from '../lib/device-id'
import { applyVideoKey } from '../lib/video-key'
import { clearHlsOfflineVideo } from '../lib/hls-loader'
import { userError } from '../lib/user-error'
import type { Account } from '../api/accounts'
import PasswordInput from '../components/PasswordInput'

interface LoginPageProps {
  phoneNumber: string
  onBack: () => void
  onSuccess: (account: Account) => void
}

const INTERNET_REQUIRED_MESSAGE = userError(
  3829,
  'Internet connection is required to log in. Please connect and try again.'
)

export default function LoginPage({
  phoneNumber: initialPhone,
  onBack,
  onSuccess
}: LoginPageProps) {
  const [phoneNumber, setPhoneNumber] = useState(initialPhone)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  /** Offline login is only for accounts with offline mode enabled. */
  async function completeOfflineLogin(trimmed: string, passwordValue: string): Promise<boolean> {
    const offline = await window.pathnatya.tryOfflineLogin(trimmed, passwordValue)
    if (!offline || !offline.account.isOffline) {
      return false
    }

    saveSession(offline.token, offline.account)
    saveLoginTokens(offline.loginTokens)
    await applyVideoKey(offline.loginTokens)

    onSuccess(offline.account)
    return true
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError('')

    const trimmed = phoneNumber.trim()
    if (!/^\d{10}$/.test(trimmed)) {
      setError(userError(674, 'Please enter a valid 10-digit phone number.'))
      return
    }

    if (!password) {
      setError(userError(219, 'Please enter your password.'))
      return
    }

    setLoading(true)
    try {
      // No network: only offline-capable accounts may continue via the local session.
      if (!(await ensureOnline())) {
        if (await completeOfflineLogin(trimmed, password)) {
          return
        }

        setError(INTERNET_REQUIRED_MESSAGE)
        return
      }

      const deviceId = await getDeviceId()
      const result = await login(trimmed, password, deviceId)
      const account: Account = {
        ...result.account,
        isOffline: result.isOffline ?? result.account.isOffline,
        chokidar: result.chokidar ?? result.account.chokidar,
        dom_security: result.dom_security ?? result.account.dom_security
      }
      saveSession(result.token, account)

      let keys: string[]
      try {
        keys = await fetchLoginTokens(result.token)
      } catch (tokenError) {
        // Tokens require the server; online-only accounts cannot fall back offline.
        if (isNetworkError(tokenError)) {
          if (account.isOffline && (await completeOfflineLogin(trimmed, password))) {
            return
          }
          setError(INTERNET_REQUIRED_MESSAGE)
          return
        }
        throw tokenError
      }

      saveLoginTokens(keys)
      await applyVideoKey(keys)

      if (!account.isOffline) {
        // Online-only: no local login session, and no leftover disk package.
        await window.pathnatya.clearOfflineSession()
        if (!isOffline()) {
          await clearHlsOfflineVideo()
        }
      } else {
        await window.pathnatya.saveOfflineSession({
          phoneNumber: trimmed,
          account,
          token: result.token,
          loginTokens: keys,
          password
        })
      }

      onSuccess(account)
    } catch (error) {
      if (isNetworkError(error)) {
        if (await completeOfflineLogin(trimmed, password)) {
          return
        }

        setError(INTERNET_REQUIRED_MESSAGE)
        return
      }

      const message =
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : 'Invalid phone number or password. Please try again.'
      const status =
        error && typeof error === 'object' && 'status' in error
          ? Number((error as { status: unknown }).status)
          : 0
      const authenticationRejected =
        status === 401 ||
        status === 403 ||
        /invalid.*(?:password|credentials)|wrong.*password|password.*incorrect/iu.test(message)
      setError(
        authenticationRejected
          ? userError(406, 'Invalid phone number or password.')
          : userError(917, message)
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page auth-page">
      <header className="page-header">
        <p className="sanskrit-header">Jay Yogeshwar</p>
        <h1>Login</h1>
        <p className="page-subtitle">Enter your phone number and password to access the video</p>
      </header>

      <form className="auth-form card" onSubmit={handleSubmit}>
        <label htmlFor="login-phone">Phone Number</label>
        <input
          id="login-phone"
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          value={phoneNumber}
          onChange={(event) => setPhoneNumber(event.target.value.replace(/\D/g, '').slice(0, 10))}
          disabled={loading}
          autoFocus={!initialPhone}
        />

        <label htmlFor="login-password">Password</label>
        <PasswordInput
          id="login-password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={loading}
          autoFocus={Boolean(initialPhone)}
        />
        {error && <p className="form-error">{error}</p>}

        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? 'Logging in...' : 'Login'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onBack} disabled={loading}>
          Back
        </button>
      </form>
    </div>
  )
}
