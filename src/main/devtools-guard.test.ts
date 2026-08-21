import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    on: vi.fn()
  }
}))

const {
  hasForbiddenDebugArgv,
  isDevToolsShortcut,
  shouldRefusePackedDebugLaunch
} = await import('./devtools-guard')

function keyDown(partial: Partial<Electron.Input> & Pick<Electron.Input, 'key'>): Electron.Input {
  return {
    type: 'keyDown',
    isAutoRepeat: false,
    code: '',
    control: false,
    shift: false,
    alt: false,
    meta: false,
    ...partial
  } as Electron.Input
}

describe('isDevToolsShortcut', () => {
  it('blocks F12', () => {
    expect(isDevToolsShortcut(keyDown({ key: 'F12', code: 'F12' }))).toBe(true)
  })

  it('blocks Ctrl+Shift+I/J/C', () => {
    expect(isDevToolsShortcut(keyDown({ key: 'I', code: 'KeyI', control: true, shift: true }))).toBe(
      true
    )
    expect(isDevToolsShortcut(keyDown({ key: 'j', code: 'KeyJ', control: true, shift: true }))).toBe(
      true
    )
    expect(isDevToolsShortcut(keyDown({ key: 'c', code: 'KeyC', control: true, shift: true }))).toBe(
      true
    )
  })

  it('blocks Cmd+Option+I on macOS layouts where key is not Latin I', () => {
    expect(
      isDevToolsShortcut(keyDown({ key: 'Dead', code: 'KeyI', meta: true, alt: true }))
    ).toBe(true)
  })

  it('ignores Ctrl+I without Shift, key-up, and auto-repeat', () => {
    expect(isDevToolsShortcut(keyDown({ key: 'i', code: 'KeyI', control: true }))).toBe(false)
    expect(isDevToolsShortcut(keyDown({ type: 'keyUp', key: 'F12', code: 'F12' }))).toBe(false)
    expect(isDevToolsShortcut(keyDown({ key: 'F12', code: 'F12', isAutoRepeat: true }))).toBe(false)
  })
})

describe('hasForbiddenDebugArgv', () => {
  it('catches inspect and remote-debugging launch flags', () => {
    expect(hasForbiddenDebugArgv(['/app/Pathnatya', '--inspect'])).toBe(true)
    expect(hasForbiddenDebugArgv(['Pathnatya.exe', '--inspect-brk=9229'])).toBe(true)
    expect(hasForbiddenDebugArgv(['Pathnatya', '--remote-debugging-port=9222'])).toBe(true)
    expect(hasForbiddenDebugArgv(['Pathnatya', '--remote-debugging-pipe'])).toBe(true)
  })

  it('allows a normal packaged launch', () => {
    expect(
      hasForbiddenDebugArgv(['/Applications/Pathnatya 2026.app/Contents/MacOS/Pathnatya 2026'])
    ).toBe(false)
    expect(hasForbiddenDebugArgv(['Pathnatya.exe', '--started-from-shortcut'])).toBe(false)
  })
})

describe('shouldRefusePackedDebugLaunch', () => {
  it('refuses when Chromium registered the switch even if argv looks clean', () => {
    expect(
      shouldRefusePackedDebugLaunch(['Pathnatya'], (name) => name === 'remote-debugging-port')
    ).toBe(true)
  })

  it('allows a launch with no debug switches', () => {
    expect(shouldRefusePackedDebugLaunch(['Pathnatya'], () => false)).toBe(false)
  })
})
