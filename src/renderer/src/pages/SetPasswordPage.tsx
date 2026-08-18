import { FormEvent, useState } from 'react'
import { setPassword } from '../api/accounts'
import PasswordInput from '../components/PasswordInput'
import { getDeviceId } from '../lib/device-id'
import { userError } from '../lib/user-error'

interface SetPasswordPageProps {
  phoneNumber: string
  onBack: () => void
  onSuccess: () => void
}

export default function SetPasswordPage({ phoneNumber, onBack, onSuccess }: SetPasswordPageProps) {
  const [password, setPasswordValue] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [teamNumber, setTeamNumber] = useState<number | null>(null)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError('')

    if (password.length < 6) {
      setError(userError(352, 'Password must be at least 6 characters.'))
      return
    }

    if (password !== confirmPassword) {
      setError(userError(684, 'Passwords do not match.'))
      return
    }

    setLoading(true)
    try {
      const deviceId = await getDeviceId()
      if (!deviceId) {
        setError(
          userError(5291, 'Unable to read this device identifier. Check your network connection.')
        )
        return
      }

      const result = await setPassword(phoneNumber, password, deviceId)
      setTeamNumber(result.teamNumber)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      setError(
        message.includes('Device identifier')
          ? userError(783, message)
          : userError(7614, 'Unable to set password. Please try again.')
      )
    } finally {
      setLoading(false)
    }
  }

  if (teamNumber !== null) {
    return (
      <div className="page auth-page">
        <header className="page-header">
          <p className="sanskrit-header">Jay Yogeshwar</p>
          <h1 className="team-number-heading">
            Hello, your team number is
            <span className="team-number-value">{teamNumber}</span>
          </h1>
        </header>

        <div className="card team-number-card">
          <button type="button" className="btn btn-primary" onClick={onSuccess}>
            Continue
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="page auth-page">
      <header className="page-header">
        <p className="sanskrit-header">Jay Yogeshwar</p>
        <h1>Set Password</h1>
        <p className="page-subtitle">
          Create a password for your account. It cannot be reset later.
        </p>
      </header>

      <form className="auth-form card" onSubmit={handleSubmit}>
        <label htmlFor="set-phone">Phone Number</label>
        <input id="set-phone" type="tel" value={phoneNumber} readOnly className="input-readonly" />

        <label htmlFor="set-password">Password</label>
        <PasswordInput
          id="set-password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPasswordValue(event.target.value)}
          disabled={loading}
          autoFocus
        />

        <label htmlFor="confirm-password">Confirm Password</label>
        <PasswordInput
          id="confirm-password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          disabled={loading}
        />

        {error && <p className="form-error">{error}</p>}

        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? 'Setting password...' : 'Set Password'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onBack} disabled={loading}>
          Back
        </button>
      </form>
    </div>
  )
}
