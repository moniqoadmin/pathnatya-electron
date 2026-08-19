import { describe, expect, it } from 'vitest'
import { buildLocation, buildPcSpecs, ramBytesToGb } from './machine-profile'

describe('ramBytesToGb', () => {
  it('rounds physical memory to one decimal gigabyte', () => {
    expect(ramBytesToGb(16 * 1024 ** 3)).toBe(16)
    expect(ramBytesToGb(8 * 1024 ** 3)).toBe(8)
    expect(ramBytesToGb(15.5 * 1024 ** 3)).toBe(15.5)
  })

  it('returns 0 for missing or invalid values', () => {
    expect(ramBytesToGb(0)).toBe(0)
    expect(ramBytesToGb(-1)).toBe(0)
    expect(ramBytesToGb(Number.NaN)).toBe(0)
  })
})

describe('buildLocation', () => {
  it('normalizes timezone, locale, and country code', () => {
    expect(
      buildLocation({
        timezone: ' Asia/Kolkata ',
        locale: ' en-IN ',
        countryCode: 'in'
      })
    ).toEqual({
      timezone: 'Asia/Kolkata',
      locale: 'en-IN',
      countryCode: 'IN'
    })
  })

  it('fills blanks when OS values are missing', () => {
    expect(buildLocation({})).toEqual({
      timezone: '',
      locale: '',
      countryCode: ''
    })
  })
})

describe('buildPcSpecs', () => {
  it('maps Windows-style hardware fields', () => {
    expect(
      buildPcSpecs({
        platform: 'win32',
        arch: 'x64',
        osRelease: '10.0.26200',
        osVersion: 'Windows 11 Pro',
        ramBytes: 16 * 1024 ** 3,
        cpuModel: ' Intel Core i7 ',
        cpuCores: 8,
        hostname: ' TEAM-LAPTOP ',
        screenWidth: 1920,
        screenHeight: 1080,
        appVersion: '4.10.0'
      })
    ).toEqual({
      platform: 'win32',
      arch: 'x64',
      osRelease: '10.0.26200',
      osVersion: 'Windows 11 Pro',
      ramBytes: 16 * 1024 ** 3,
      ramGb: 16,
      cpuModel: 'Intel Core i7',
      cpuCores: 8,
      hostname: 'TEAM-LAPTOP',
      screenWidth: 1920,
      screenHeight: 1080,
      appVersion: '4.10.0'
    })
  })
})
