import { FormEvent, useState } from 'react'
import { checkPhone } from '../api/accounts'
import { ensureOnline } from '../lib/connectivity'
import { getDeviceId } from '../lib/device-id'
import { isNetworkError } from '../lib/network'
import { userError } from '../lib/user-error'
import { VIDEO_FILES_TAMPERED_LOGIN_MESSAGE } from '../lib/hls-loader'
import {
  isValidPhoneNumber,
  PHONE_NUMBER_MAX_LENGTH,
  sanitizePhoneInput
} from '../../../shared/phone-number'

interface PhoneCheckPageProps {
  onBack: () => void
  onExistingAccount: (phoneNumber: string) => void
  onNeedsPassword: (phoneNumber: string) => void
}

const CONNECT_TO_INTERNET_TO_LOGIN = userError(2714, 'Connect to internet to login')

export default function PhoneCheckPage({
  onBack,
  onExistingAccount,
  onNeedsPassword
}: PhoneCheckPageProps) {
  const [phoneNumber, setPhoneNumber] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError('')

    const trimmed = phoneNumber.trim()
    if (!isValidPhoneNumber(trimmed)) {
      setError(userError(318, 'Please enter a valid 8, 9 or 10-digit phone number.'))
      return
    }

    setLoading(true)
    try {
      if (!(await ensureOnline())) {
        await continueOffline(trimmed)
        return
      }

      const deviceId = await getDeviceId()
      if (!deviceId) {
        setError(
          userError(5291, 'Unable to read this device identifier. Check your network connection.')
        )
        return
      }

      const result = await checkPhone(trimmed, deviceId)

      if (!result.exists) {
        setError(userError(742, 'Wrong phone number. Please check and try again.'))
        return
      }

      if (result.needsPassword) {
        onNeedsPassword(trimmed)
      } else {
        onExistingAccount(trimmed)
      }
    } catch (error) {
      if (isNetworkError(error)) {
        await continueOffline(trimmed)
        return
      }

      const message =
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : 'Unable to verify phone number. Please try again.'
      setError(userError(917, message))
    } finally {
      setLoading(false)
    }
  }

  async function continueOffline(trimmed: string): Promise<void> {
    if (await window.pathnatya.isVideoTampered()) {
      setError(VIDEO_FILES_TAMPERED_LOGIN_MESSAGE)
      return
    }

    if (await window.pathnatya.isOfflineCheckInRequired()) {
      setError(CONNECT_TO_INTERNET_TO_LOGIN)
      return
    }

    // Only offline-capable accounts get a local session; online-only must be online.
    if (await window.pathnatya.hasOfflineSession(trimmed)) {
      onExistingAccount(trimmed)
      return
    }

    setError(
      userError(
        3829,
        'Internet connection is required to continue. Please connect and try again.'
      )
    )
  }

  return (
    <div className="page auth-page">
      <header className="page-header">
        <p className="sanskrit-header">Jay Yogeshwar</p>
        <h1>Pathnatya 2026</h1>
        <p className="page-subtitle">Enter your registered phone number to continue</p>
      </header>

      <form className="auth-form card" onSubmit={handleSubmit}>
        <label htmlFor="phone-check">Phone Number</label>
        <input
          id="phone-check"
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          maxLength={PHONE_NUMBER_MAX_LENGTH}
          placeholder="8, 9 or 10 digits"
          value={phoneNumber}
          onChange={(event) => setPhoneNumber(sanitizePhoneInput(event.target.value))}
          disabled={loading}
          autoFocus
        />

        {error && <p className="form-error">{error}</p>}

        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? 'Checking...' : 'Continue'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onBack} disabled={loading}>
          Back
        </button>
      </form>
    </div>
  )
}
