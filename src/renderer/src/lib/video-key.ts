/** Hands the video key to main, which keeps it in memory for segment decryption. */
export async function applyVideoKey(loginTokens: string[]): Promise<void> {
  const token = loginTokens[sessionTokenSlot()]

  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('629 : Login response issue. Please contact admin.')
  }

  await window.pathnatya.setVideoKey(token)
}

export function clearVideoKey(): void {
  void window.pathnatya.clearVideoKey()
}

function sessionTokenSlot(): number {
  const packed = [0x4f, 0x4a]
  return (packed[0] ^ packed[1]) >>> 0
}
