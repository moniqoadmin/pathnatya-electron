import { describe, expect, it } from 'vitest'
import {
  formatTopmostWindowLabel,
  isInspectableWindow,
  isShellWindowClass,
  listBlockingTopmostWindows,
  parseTopmostWindowsDump,
  pickBlockingTopmostApp,
  shouldIgnoreTopmostTitle,
  type TopmostWindow
} from './topmost-guard'

function win(partial: Partial<TopmostWindow> & Pick<TopmostWindow, 'title' | 'pid'>): TopmostWindow {
  const alwaysOnTop = partial.alwaysOnTop ?? true
  return {
    hwnd: '1',
    app: 'SomeApp',
    className: 'Chrome_WidgetWin_1',
    toolWindow: false,
    ...partial,
    alwaysOnTop,
    pinned: partial.pinned ?? alwaysOnTop
  }
}

describe('shouldIgnoreTopmostTitle', () => {
  it('ignores Window Inspector', () => {
    expect(shouldIgnoreTopmostTitle('Window Inspector')).toBe(true)
    expect(shouldIgnoreTopmostTitle('  window inspector — debug  ')).toBe(true)
  })

  it('ignores Pathnatya titles', () => {
    expect(shouldIgnoreTopmostTitle('Pathnatya 2026')).toBe(true)
  })

  it('does not ignore blank titles', () => {
    expect(shouldIgnoreTopmostTitle('')).toBe(false)
    expect(shouldIgnoreTopmostTitle('   ')).toBe(false)
  })

  it('keeps ordinary app titles', () => {
    expect(shouldIgnoreTopmostTitle('Sticky Notes')).toBe(false)
    expect(shouldIgnoreTopmostTitle('Task Manager')).toBe(false)
  })
})

describe('pickBlockingTopmostApp', () => {
  it('returns the first pinned foreign app', () => {
    const name = pickBlockingTopmostApp(
      [
        win({ title: 'Window Inspector', app: 'electron', pid: 99 }),
        win({ title: 'Notes', app: 'StikyNot', pid: 42 })
      ],
      7
    )
    expect(name).toBe('Notes (StikyNot)')
  })

  it('blocks TOPMOST tool-window overlays', () => {
    expect(
      pickBlockingTopmostApp([win({ title: 'Pin', app: 'DeskPin', pid: 42, toolWindow: true })], 7)
    ).toBe('Pin (DeskPin)')
  })

  it('skips our own PID and shell classes', () => {
    expect(
      pickBlockingTopmostApp(
        [
          win({ title: 'Ours', app: 'pathnatya', pid: 7 }),
          win({
            title: 'Taskbar',
            app: 'explorer',
            pid: 100,
            className: 'Shell_TrayWnd'
          }),
          win({
            title: '',
            app: 'explorer',
            pid: 100,
            className: 'ThumbnailDeviceHelperWnd'
          })
        ],
        7
      )
    ).toBeNull()
  })

  it('ignores Window Inspector chrome titles', () => {
    expect(
      pickBlockingTopmostApp(
        [
          win({
            title: 'Electron Window Inspector - Google Chrome',
            app: 'chrome',
            pid: 9
          })
        ],
        1
      )
    ).toBeNull()
  })

  it('ignores non-topmost rows', () => {
    expect(
      pickBlockingTopmostApp([win({ title: 'Chrome', app: 'chrome', pid: 9, alwaysOnTop: false })], 1)
    ).toBeNull()
  })
})

describe('listBlockingTopmostWindows', () => {
  it('returns every pinned foreign window', () => {
    const rows = listBlockingTopmostWindows(
      [
        win({ title: 'Window Inspector', app: 'electron', pid: 99 }),
        win({ title: 'Notes', app: 'StikyNot', pid: 42 }),
        win({ title: 'Calculator', app: 'Calculator', pid: 50 }),
        win({ title: 'Chrome', app: 'chrome', pid: 9, alwaysOnTop: false })
      ],
      7
    )
    expect(rows.map((row) => formatTopmostWindowLabel(row))).toEqual([
      'Notes (StikyNot)',
      'Calculator'
    ])
  })
})

describe('parseTopmostWindowsDump', () => {
  it('parses pipe-delimited scanner rows', () => {
    const rows = parseTopmostWindowsDump(
      '42|Hello|chrome|9|Chrome_WidgetWin_1|1|0\n99|Tray|explorer|4|Shell_TrayWnd|0|0\n'
    )
    expect(rows).toEqual([
      {
        hwnd: '42',
        title: 'Hello',
        app: 'chrome',
        pid: 9,
        className: 'Chrome_WidgetWin_1',
        alwaysOnTop: true,
        pinned: true,
        toolWindow: false
      },
      {
        hwnd: '99',
        title: 'Tray',
        app: 'explorer',
        pid: 4,
        className: 'Shell_TrayWnd',
        alwaysOnTop: false,
        pinned: false,
        toolWindow: false
      }
    ])
  })
})

describe('isShellWindowClass', () => {
  it('recognises tray and desktop classes', () => {
    expect(isShellWindowClass('Shell_TrayWnd')).toBe(true)
    expect(isShellWindowClass('Progman')).toBe(true)
    expect(isShellWindowClass('Chrome_WidgetWin_1')).toBe(false)
  })
})

describe('isInspectableWindow', () => {
  it('drops untitled and shell chrome rows', () => {
    expect(
      isInspectableWindow({
        title: '',
        app: 'explorer',
        className: 'ThumbnailDeviceHelperWnd',
        toolWindow: true
      })
    ).toBe(false)

    expect(
      isInspectableWindow({
        title: 'Task Manager',
        app: 'Taskmgr',
        className: 'TaskManagerWindow',
        toolWindow: false
      })
    ).toBe(true)
  })
})
