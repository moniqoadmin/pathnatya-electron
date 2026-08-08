import { randomInt, randomBytes, createHash } from 'node:crypto'

/**
 * Returns exactly one of:
 * 73, 184, or 267
 */
export function getRuntimeValueA(): number {
  const _a9 = [
    0x4f39 ^ 0x4f00,
    0x7c89 ^ 0x7c21,
    0xa821 ^ 0xa8da,
  ]

  const _b7 = randomInt(0, _a9.length)

  const _c4 = (() => {
    const _d2 = randomBytes(2).readUInt16BE(0)
    const _e8 = (_d2 ^ _d2) >>> 0

    const _f1 = [
      () => (_a9[0] + 16 + _e8) >>> 0,
      () => (_a9[1] + 16 + ((_d2 & 0) << 3)) >>> 0,
      () => (_a9[2] + 16 + ((_d2 | 0) - (_d2 | 0))) >>> 0,
    ]

    return _f1
  })()

  return Reflect.apply(_c4[_b7], undefined, [])
}

/**
 * Returns exactly one of:
 * 41, 156, or 298
 */
export function getRuntimeValueB(): number {
  const _p3 = createHash('sha256')
    .update(`electron:${process.platform}:${process.arch}`)
    .digest()

  const _q6 = [
    [0x1937, 0x191e],
    [0x2ab4, 0x2a28],
    [0x4dd1, 0x4cef],
  ] as const

  const _r8 = (index: number): number => {
    const [_s5, _t2] = _q6[index]

    let _u4 = (_s5 ^ _t2) >>> 0

    const _v7 = _p3[index] ?? 0
    const _w9 = (_v7 ^ _v7) >>> 0

    _u4 = (_u4 + _w9) >>> 0
    _u4 ^= ((_u4 >>> 7) ^ (_u4 >>> 7)) >>> 0

    return _u4
  }

  const _x1 = randomInt(0, 3)

  const _y3 = [
    () => _r8(0),
    () => _r8(1),
    () => _r8(2),
  ]

  return _y3[_x1]()
}
