import { describe, expect, it } from 'vitest'
import {
  findCapturingAppInConsentDump,
  matchRecorderByKeyword,
  parsePackagedRecorders
} from './capture-guard'

const CONSENT_DUMP = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\graphicsCaptureWithoutBorder
    Value    REG_SZ    Allow
    LastSetTime    REG_QWORD    0x1dd03f968b32b3c

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\graphicsCaptureWithoutBorder\\Microsoft.ScreenSketch_8wekyb3d8bbwe
    Value    REG_SZ    Allow
    LastSetTime    REG_QWORD    0x1dd044f9554b67a
    LastUsedTimeStart    REG_QWORD    0x1dd267290343486
    LastUserAnnotatedLabel    REG_DWORD    0x2
    LastUsedTimeStop    REG_QWORD    0x1dd267290369e2a
    PersistedInDatabase    REG_DWORD    0x1

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\graphicsCaptureWithoutBorder\\MSTeams_8wekyb3d8bbwe
    Value    REG_SZ    Prompt
    LastSetTime    REG_QWORD    0x1dd03d11dc11ea0

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\graphicsCaptureWithoutBorder\\NonPackaged
    Value    REG_SZ    Allow
    LastSetTime    REG_QWORD    0x1dd04a777643ce5

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\graphicsCaptureWithoutBorder\\NonPackaged\\C:#Program Files#Google#Chrome#Application#chrome.exe
    LastUsedTimeStart    REG_QWORD    0x1dd2765f6df10ec
    LastUserAnnotatedLabel    REG_DWORD    0x2
    LastUsedTimeStop    REG_QWORD    0x0
    PersistedInDatabase    REG_DWORD    0x1
`

const RECORDING_SNIPPING_TOOL = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\graphicsCaptureWithoutBorder\\Microsoft.ScreenSketch_8wekyb3d8bbwe
    Value    REG_SZ    Allow
    LastUsedTimeStart    REG_QWORD    0x1dd267290343486
    LastUsedTimeStop    REG_QWORD    0x0
    PersistedInDatabase    REG_DWORD    0x1
`

describe('capture consent parsing', () => {
  it('reports an app whose capture session is still open', () => {
    expect(findCapturingAppInConsentDump(CONSENT_DUMP, ['chrome.exe', 'explorer.exe'])).toBe(
      'Google Chrome'
    )
  })

  it('ignores an open session when the owning process is gone', () => {
    expect(findCapturingAppInConsentDump(CONSENT_DUMP, ['explorer.exe'])).toBeNull()
  })

  it('ignores sessions that already stopped', () => {
    const finished = CONSENT_DUMP.replace(
      'LastUsedTimeStop    REG_QWORD    0x0',
      'LastUsedTimeStop    REG_QWORD    0x1dd2765f6df20ec'
    )

    expect(findCapturingAppInConsentDump(finished, ['chrome.exe'])).toBeNull()
  })

  it('names packaged apps such as the Snipping Tool recorder', () => {
    expect(findCapturingAppInConsentDump(RECORDING_SNIPPING_TOOL, [])).toBe('Snipping Tool')
  })

  it('ignores apps that have never captured', () => {
    const neverUsed = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\graphicsCaptureProgrammatic\\MSTeams_8wekyb3d8bbwe
    Value    REG_SZ    Prompt
    LastSetTime    REG_QWORD    0x1dd03d11dbd9221
`

    expect(findCapturingAppInConsentDump(neverUsed, [])).toBeNull()
  })
})

describe('recorder keyword heuristic', () => {
  it('catches an unknown recorder by its name', () => {
    expect(
      matchRecorderByKeyword(['explorer.exe', 'screen record md.exe', 'chrome.exe'])
    ).toBe('Screen Record Md')
  })

  it('catches names using separators', () => {
    expect(matchRecorderByKeyword(['free-screen-recorder.exe'])).toBe('Free Screen Recorder')
  })

  it('ignores ordinary processes', () => {
    expect(matchRecorderByKeyword(['explorer.exe', 'chrome.exe', 'code.exe'])).toBeNull()
  })

  it('cannot catch a recorder with an innocuous executable name', () => {
    // RecForth.exe is the real Store recorder that slipped through, which is why
    // packaged-app discovery exists.
    expect(matchRecorderByKeyword(['recforth.exe'])).toBeNull()
  })
})

describe('packaged recorder discovery', () => {
  const SCAN_OUTPUT = [
    'Microsoft.ScreenSketch|SnippingTool\\SnippingTool.exe',
    'IOForth.Screenrecord-screenrecorder|Screen_Record\\RecForth.exe',
    ''
  ].join('\r\n')

  it('maps a Store recorder to the executable it runs as', () => {
    expect(parsePackagedRecorders(SCAN_OUTPUT)).toEqual([
      { executable: 'snippingtool.exe', appName: 'ScreenSketch' },
      { executable: 'recforth.exe', appName: 'Screenrecorder' }
    ])
  })

  it('skips malformed and duplicate lines', () => {
    const messy = ['', 'NoPipeHere', 'Some.App|readme.txt', ...SCAN_OUTPUT.split('\r\n')].join('\n')

    expect(parsePackagedRecorders(messy).map((entry) => entry.executable)).toEqual([
      'snippingtool.exe',
      'recforth.exe'
    ])
  })
})
