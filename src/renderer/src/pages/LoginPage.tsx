import { FormEvent, useState } from 'react'
import { getLoginTokens as fetchLoginTokens, login } from '../api/accounts'
import { postAppLog } from '../api/logs'
import { saveLoginTokens, saveSession } from '../lib/storage'
import { ensureOnline } from '../lib/connectivity'
import { isNetworkError, isOffline } from '../lib/network'
import { getDeviceId } from '../lib/device-id'
import { applyAppConfiguration } from '../lib/app-configuration'
import { applyVideoKey } from '../lib/video-key'
import { clearHlsOfflineVideo, VIDEO_FILES_TAMPERED_LOGIN_MESSAGE } from '../lib/hls-loader'
import { userError } from '../lib/user-error'
import type { Account } from '../api/accounts'
import PasswordInput from '../components/PasswordInput'

interface LoginPageProps {
  phoneNumber: string
  onBack: () => void
  onSuccess: (account: Account) => void
  /** After a leftover lock file: post /logs, clear only on success, then end session. */
  onTamperLogout: () => void
}

const INTERNET_REQUIRED_MESSAGE = userError(
  3829,
  'Internet connection is required to log in. Please connect and try again.'
)

const CONNECT_TO_INTERNET_TO_LOGIN = userError(2714, 'Connect to internet to login')

export default function LoginPage({
  phoneNumber: initialPhone,
  onBack,
  onSuccess,
  onTamperLogout
}: LoginPageProps) {
  const [phoneNumber, setPhoneNumber] = useState(initialPhone)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  /** Offline login is only for accounts with offline mode enabled. */
  async function completeOfflineLogin(
    trimmed: string,
    passwordValue: string
  ): Promise<'ok' | 'needs_internet' | 'invalid' | 'tampered'> {
    const offline = await window.pathnatya.tryOfflineLogin(trimmed, passwordValue)
    if (!offline.ok) {
      return offline.reason
    }

    if (!offline.account.isOffline) {
      return 'invalid'
    }

    saveSession(offline.token, offline.account)
    saveLoginTokens(offline.loginTokens)
    await applyVideoKey(offline.loginTokens)

    onSuccess(offline.account)
    return 'ok'
  }

  function setOfflineLoginError(result: 'needs_internet' | 'invalid' | 'tampered'): void {
    if (result === 'tampered') {
      setError(VIDEO_FILES_TAMPERED_LOGIN_MESSAGE)
      return
    }

    setError(result === 'needs_internet' ? CONNECT_TO_INTERNET_TO_LOGIN : INTERNET_REQUIRED_MESSAGE)
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
        const offlineResult = await completeOfflineLogin(trimmed, password)
        if (offlineResult === 'ok') {
          return
        }

        setOfflineLoginError(offlineResult)
        return
      }

      const deviceId = await getDeviceId()
      const result = await login(trimmed, password, deviceId)
      const account: Account = {
        ...result.account,
        isOffline: result.isOffline ?? result.account.isOffline,
        chokidar: true,
        dom_security: true,
        numberOfReboot: result.numberOfReboot ?? result.account.numberOfReboot,
        logoutButton: (result.logoutButton ?? result.account.logoutButton) === true,
        teamNumber: result.team?.teamNumber ?? result.account.teamNumber
      }
      saveSession(result.token, account)

      let keys: string[]
      try {
        keys = await fetchLoginTokens(result.token)
        await applyAppConfiguration(result.token)
        if (await window.pathnatya.isVideoTampered()) {
          let logged = false
          try {
            logged = await postAppLog('FILES_TAMPERED', true, result.token, {
              timeoutMs: 8_000,
              retries: 0
            })
          } catch (error) {
            console.error('Unable to report FILES_TAMPERED log:', error)
          }

          // Clear only after a successful /logs so a failed post can retry next login.
          if (logged) {
            await window.pathnatya.clearVideoTamperLock()
          }
          onTamperLogout()
          return
        }
      } catch (tokenError) {
        // Tokens and video config require the server; online-only accounts cannot fall back.
        if (isNetworkError(tokenError)) {
          const offlineResult = await completeOfflineLogin(trimmed, password)
          if (offlineResult === 'ok') {
            return
          }
          setOfflineLoginError(offlineResult)
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
        const offlineResult = await completeOfflineLogin(trimmed, password)
        if (offlineResult === 'ok') {
          return
        }

        setOfflineLoginError(offlineResult)
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
