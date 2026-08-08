import { afterEach, describe, expect, it } from 'vitest'
import { clearHlsKey, getHlsKey, setHlsKey } from './hls-key'

/** Arbitrary 16-byte key with bytes above 0x7f, like a real AES-128 key. */
const RAW_KEY = Buffer.from('ab0d5970fcac8d2494e8d69992207f01', 'hex')

afterEach(() => {
  clearHlsKey()
})

describe('setHlsKey', () => {
  it('accepts a hex token in any case, padded or 0x-prefixed', () => {
    setHlsKey(RAW_KEY.toString('hex'))
    expect(getHlsKey().equals(RAW_KEY)).toBe(true)

    setHlsKey(`  ${RAW_KEY.toString('hex').toUpperCase()}\n`)
    expect(getHlsKey().equals(RAW_KEY)).toBe(true)

    setHlsKey(`0x${RAW_KEY.toString('hex')}`)
    expect(getHlsKey().equals(RAW_KEY)).toBe(true)
  })

  it('accepts base64 and base64url tokens', () => {
    setHlsKey(RAW_KEY.toString('base64'))
    expect(getHlsKey().equals(RAW_KEY)).toBe(true)

    setHlsKey(RAW_KEY.toString('base64url'))
    expect(getHlsKey().equals(RAW_KEY)).toBe(true)
  })

  it('accepts a raw binary string carrying one byte per character', () => {
    setHlsKey(RAW_KEY.toString('latin1'))
    expect(getHlsKey().equals(RAW_KEY)).toBe(true)
  })

  it('accepts a 16-character passphrase', () => {
    setHlsKey('0123456789abcdef')
    expect(getHlsKey().toString('utf8')).toBe('0123456789abcdef')
  })

  it('keeps whitespace that belongs to a raw key', () => {
    const spaced = Buffer.from('20616263646566676869616263646520', 'hex')
    setHlsKey(spaced.toString('latin1'))
    expect(getHlsKey().equals(spaced)).toBe(true)
  })

  it('rejects a token of the wrong length', () => {
    expect(() => setHlsKey('too-short')).toThrow(/16 bytes/u)
    expect(() => setHlsKey('')).toThrow(/empty/u)
  })
})

describe('getHlsKey', () => {
  it('throws until a key is installed and after it is cleared', () => {
    expect(() => getHlsKey()).toThrow(/log in again/u)

    setHlsKey(RAW_KEY.toString('hex'))
    expect(getHlsKey()).toBeInstanceOf(Buffer)

    clearHlsKey()
    expect(() => getHlsKey()).toThrow(/log in again/u)
  })
})
