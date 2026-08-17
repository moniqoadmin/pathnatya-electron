import { describe, expect, it } from 'vitest'
import { isUptimeReboot, nextBootId, UPTIME_REBOOT_SLACK_SEC } from './boot-id'

describe('boot-id', () => {
  it('does not treat missing prior uptime as a reboot', () => {
    expect(isUptimeReboot(undefined, 12)).toBe(false)
  })

  it('detects an uptime regression beyond slack', () => {
    expect(isUptimeReboot(10_000, 3)).toBe(true)
    expect(isUptimeReboot(10_000, 10_000 - UPTIME_REBOOT_SLACK_SEC - 1)).toBe(true)
  })

  it('ignores small uptime jitter', () => {
    expect(isUptimeReboot(10_000, 10_000)).toBe(false)
    expect(isUptimeReboot(10_000, 10_000 - UPTIME_REBOOT_SLACK_SEC)).toBe(false)
    expect(isUptimeReboot(10_000, 10_001)).toBe(false)
  })

  it('reuses a generated id until reboot when the OS has none', () => {
    const previous = 'kept-boot'
    expect(nextBootId(null, false, previous)).toBe(previous)

    const minted = nextBootId(null, true, previous)
    expect(minted).not.toBe(previous)
    expect(minted).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )
  })

  it('prefers the OS boot identifier', () => {
    expect(nextBootId('os-boot-9', true, 'previous')).toBe('os-boot-9')
    expect(nextBootId('os-boot-9', false, 'previous')).toBe('os-boot-9')
  })
})
