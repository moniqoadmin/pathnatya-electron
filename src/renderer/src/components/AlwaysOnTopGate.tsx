import { IconLock } from './VideoIcons'

/** Full-app block when another window is pinned always-on-top (Window Inspector excluded). */
export default function AlwaysOnTopGate({ windows = [] }: { windows?: string[] }) {
  return (
    <div
      className="always-on-top-gate"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="always-on-top-gate-title"
      aria-describedby="always-on-top-gate-desc"
    >
      <div className="always-on-top-gate-card">
        <span className="always-on-top-gate-icon" aria-hidden="true">
          <IconLock />
        </span>
        <h2 id="always-on-top-gate-title" className="always-on-top-gate-title">
          4729 : Always-on-top window detected
        </h2>
        <p id="always-on-top-gate-desc" className="always-on-top-gate-desc">
          Another window is pinned above Pathnatya. Turn off Always on top / unpin that window to
          continue.
        </p>
        {windows.length > 0 ? (
          <ul className="always-on-top-gate-windows">
            {windows.map((label, index) => (
              <li key={`${index}:${label}`}>{label}</li>
            ))}
          </ul>
        ) : null}
        <p className="always-on-top-gate-hint">This screen will clear automatically once it is removed.</p>
      </div>
    </div>
  )
}
