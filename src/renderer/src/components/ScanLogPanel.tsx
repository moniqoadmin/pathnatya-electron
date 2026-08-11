import { useEffect, useRef, useState } from 'react'
import type { ScanLogEntry } from '../env'

/** Keep the on-screen log bounded so the panel itself never leaks memory. */
const MAX_ENTRIES = 300

const LEVEL_COLORS: Record<ScanLogEntry['level'], string> = {
  info: '#9ca3af',
  found: '#34d399',
  progress: '#60a5fa',
  summary: '#fbbf24',
  error: '#f87171'
}

const ENGINE_COLORS: Record<'streaming', string> = {
  streaming: '#2dd4bf'
}

type Entry = ScanLogEntry & { id: number }

type SummaryRow = {
  engine: 'streaming'
  message: string
  time: number
}

export default function ScanLogPanel() {
  const [entries, setEntries] = useState<Entry[]>([])
  const [summaries, setSummaries] = useState<SummaryRow[]>([])
  const [collapsed, setCollapsed] = useState(false)
  const idRef = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  useEffect(() => {
    return window.pathnatya.onScanLog((entry) => {
      setEntries((prev) => {
        const next = [...prev, { ...entry, id: idRef.current++ }]
        return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
      })

      if (entry.level === 'summary' && entry.engine) {
        setSummaries((prev) => {
          const next = [...prev, { engine: entry.engine!, message: entry.message, time: entry.time }]
          return next.length > 8 ? next.slice(next.length - 8) : next
        })
      }
    })
  }, [])

  // Auto-scroll to the newest line while the user is at the bottom.
  useEffect(() => {
    const list = listRef.current
    if (list && pinnedRef.current) {
      list.scrollTop = list.scrollHeight
    }
  }, [entries])

  const onScroll = (): void => {
    const list = listRef.current
    if (!list) {
      return
    }
    pinnedRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24
  }

  return (
    <div
      style={{
        position: 'fixed',
        right: 12,
        bottom: 12,
        width: 520,
        maxWidth: '52vw',
        zIndex: 9999,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11,
        color: '#e5e7eb',
        background: 'rgba(17, 24, 39, 0.92)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        overflow: 'hidden',
        backdropFilter: 'blur(4px)'
      }}
    >
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        style={{
          width: '100%',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 10px',
          background: 'rgba(255,255,255,0.06)',
          border: 'none',
          color: '#e5e7eb',
          cursor: 'pointer',
          font: 'inherit',
          fontWeight: 600
        }}
      >
        <span>
          Drive scan ·{' '}
          <span style={{ color: ENGINE_COLORS.streaming, fontWeight: 500 }}>streaming</span>
          {` (${entries.length})`}
        </span>
        <span aria-hidden="true">{collapsed ? '▲' : '▼'}</span>
      </button>

      {!collapsed && (
        <>
          {summaries.length > 0 && (
            <div
              style={{
                padding: '6px 10px',
                borderBottom: '1px solid rgba(255,255,255,0.08)',
                background: 'rgba(0,0,0,0.25)',
                maxHeight: 110,
                overflowY: 'auto'
              }}
            >
              <div style={{ color: '#9ca3af', marginBottom: 4, fontWeight: 600 }}>
                Scan summaries (start → peak → after RSS)
              </div>
              {summaries.map((row, index) => (
                <div
                  key={`${row.time}-${index}`}
                  style={{ color: ENGINE_COLORS[row.engine], marginBottom: 2, whiteSpace: 'pre-wrap' }}
                >
                  {row.message}
                </div>
              ))}
            </div>
          )}

          <div
            ref={listRef}
            onScroll={onScroll}
            style={{
              maxHeight: 200,
              overflowY: 'auto',
              padding: '6px 10px',
              lineHeight: 1.5
            }}
          >
            {entries.length === 0 ? (
              <div style={{ color: '#6b7280' }}>Waiting for scan to start…</div>
            ) : (
              entries.map((entry) => (
                <div
                  key={entry.id}
                  style={{ color: LEVEL_COLORS[entry.level], whiteSpace: 'pre-wrap' }}
                >
                  <span style={{ color: '#6b7280' }}>
                    {new Date(entry.time).toLocaleTimeString()}{' '}
                  </span>
                  {entry.engine && (
                    <span style={{ color: ENGINE_COLORS[entry.engine], fontWeight: 600 }}>
                      [{entry.engine}]{' '}
                    </span>
                  )}
                  {entry.message}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}
