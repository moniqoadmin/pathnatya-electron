import { useEffect, useState } from 'react'
import type { AppPermission, AppPermissionsStatus, PermissionId } from '../env'

interface PermissionsPageProps {
  status: AppPermissionsStatus
  checking: boolean
  onRecheck: () => void
  onOpenSettings: (id?: PermissionId) => void
  onRelaunch?: () => void
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
          {!item.granted && (
            <>
              <p className="permission-description">{item.description}</p>
              <p className="permission-howto">{item.howToEnable}</p>
            </>
          )}
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
  onOpenSettings,
  onRelaunch
}: PermissionsPageProps) {
  const [platformLabel, setPlatformLabel] = useState('this device')

  useEffect(() => {
    const platform = window.pathnatya.getPlatform()
    setPlatformLabel(platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'this device')
  }, [])

  const isMac = status.platform === 'darwin'
  const missing = status.permissions.filter((item) => item.required && !item.granted)
  const deniedFolders = missing.filter((item) => item.id !== 'accessibility')
  const needsAccessibilityRestart = missing.some((item) => item.id === 'accessibility')
  const requiredCount = status.permissions.filter((item) => item.required).length

  return (
    <div className="page permissions-page">
      <header className="page-header">
        <p className="sanskrit-header">Jay Yogeshwar</p>
        <h1>Pathnatya 2026</h1>
        <p className="page-subtitle">Please give all required permissions</p>
      </header>

      <section className="card permissions-card">
        <h2>
          {requiredCount} permissions required on {platformLabel}
        </h2>
        <p className="permissions-lead">
          {isMac
            ? 'macOS will ask for your music library, Photo Library, Desktop, Documents, Downloads, and Accessibility. Choose Allow on each prompt, then tap Check again. If Accessibility is already on, tap Restart Pathnatya.'
            : 'Pathnatya needs the permissions below before you can continue. Turn each one on in system settings, then tap Check again.'}
        </p>

        <ul className="permission-list">
          {status.permissions.map((item) => (
            <PermissionRow key={item.id} item={item} onOpenSettings={onOpenSettings} />
          ))}
        </ul>

        {missing.length > 0 && (
          <p className="form-error permissions-error" role="alert">
            {deniedFolders.length === 1
              ? `You denied ${deniedFolders[0].label}. Turn it on in System Settings to continue.`
              : deniedFolders.length > 1
                ? `You denied ${deniedFolders.map((item) => item.label).join(', ')}. Turn each one on to continue.`
                : ''}
            {needsAccessibilityRestart
              ? `${deniedFolders.length > 0 ? ' ' : ''}Accessibility is already on, but this running app cannot use it yet. Tap Restart Pathnatya — closing the window is not enough.`
              : ''}
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
        {needsAccessibilityRestart && onRelaunch && (
          <button type="button" className="btn btn-primary" onClick={onRelaunch} disabled={checking}>
            Restart Pathnatya
          </button>
        )}
        <button
          type="button"
          className={needsAccessibilityRestart ? 'btn btn-secondary' : 'btn btn-primary'}
          onClick={onRecheck}
          disabled={checking}
        >
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
    </div>
  )
}
