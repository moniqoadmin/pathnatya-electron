import { useEffect, useState } from 'react'
import type { AppPermission, AppPermissionsStatus, PermissionId } from '../env'

interface PermissionsPageProps {
  status: AppPermissionsStatus
  checking: boolean
  onRecheck: () => void
  onOpenSettings: (id?: PermissionId) => void
}

function PermissionRow({
  item,
  onOpenSettings
}: {
  item: AppPermission
  onOpenSettings: (id: PermissionId) => void
}) {
  return (
    <li className={`permission-row ${item.granted ? 'is-granted' : 'is-missing'}`}>
      <div className="permission-row-main">
        <span className="permission-status" aria-hidden="true">
          {item.granted ? '✓' : '!'}
        </span>
        <div className="permission-copy">
          <p className="permission-label">{item.label}</p>
          <p className="permission-description">{item.description}</p>
          {!item.granted && <p className="permission-howto">{item.howToEnable}</p>}
        </div>
      </div>
      {!item.granted && (
        <button
          type="button"
          className="btn btn-secondary permission-open-btn"
          onClick={() => onOpenSettings(item.id)}
        >
          Open settings
        </button>
      )}
    </li>
  )
}

export default function PermissionsPage({
  status,
  checking,
  onRecheck,
  onOpenSettings
}: PermissionsPageProps) {
  const [platformLabel, setPlatformLabel] = useState('this device')

  useEffect(() => {
    const platform = window.pathnatya.getPlatform()
    setPlatformLabel(platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'this device')
  }, [])

  const missing = status.permissions.filter((item) => item.required && !item.granted)

  return (
    <div className="page permissions-page">
      <header className="page-header">
        <p className="sanskrit-header">Jay Yogeshwar</p>
        <h1>Pathnatya 2026</h1>
        <p className="page-subtitle">Please give all required permissions</p>
      </header>

      <section className="card permissions-card">
        <h2>Permissions required on {platformLabel}</h2>
        <p className="permissions-lead">
          Pathnatya needs the permissions below before you can continue. Turn each one on in system
          settings, then tap Check again.
        </p>

        <ul className="permission-list">
          {status.permissions.map((item) => (
            <PermissionRow key={item.id} item={item} onOpenSettings={onOpenSettings} />
          ))}
        </ul>

        {missing.length > 0 && (
          <p className="form-error permissions-error" role="status">
            {missing.length === 1
              ? '1 permission is still missing.'
              : `${missing.length} permissions are still missing.`}
          </p>
        )}
      </section>

      <div className="permissions-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => onOpenSettings()}
          disabled={checking}
        >
          Open system settings
        </button>
        <button type="button" className="btn btn-primary" onClick={onRecheck} disabled={checking}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
    </div>
  )
}
