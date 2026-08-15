import { FormEvent, useState } from 'react'
import { checkPhone } from '../api/accounts'
import { ensureOnline } from '../lib/connectivity'
import { isNetworkError } from '../lib/network'
import { userError } from '../lib/user-error'

interface PhoneCheckPageProps {
  onBack: () => void
  onExistingAccount: (phoneNumber: string) => void
  onNeedsPassword: (phoneNumber: string) => void
}

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
    if (!/^\d{10}$/.test(trimmed)) {
      setError(userError(318, 'Please enter a valid 10-digit phone number.'))
      return
    }

    setLoading(true)
    try {
      // The watcher usually already knows; this only costs a round-trip when stale.
      if (!(await ensureOnline())) {
        await continueOffline(trimmed)
        return
      }

      const result = await checkPhone(trimmed)

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

      setError(userError(965, 'Unable to verify phone number. Please try again.'))
    } finally {
      setLoading(false)
    }
  }

  async function continueOffline(trimmed: string): Promise<void> {
    if (await window.pathnatya.hasOfflineSession(trimmed)) {
      onExistingAccount(trimmed)
      return
    }

    setError(
      userError(
        5831,
        'No internet connection. Offline access is only available within 7 days of a successful online login on this device.'
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
          placeholder="9876543210"
          value={phoneNumber}
          onChange={(event) => setPhoneNumber(event.target.value.replace(/\D/g, '').slice(0, 10))}
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
