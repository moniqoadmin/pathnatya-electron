/** Position of the AES-128 video key inside the `/accounts/login-token` key list. */
const VIDEO_KEY_TOKEN_INDEX = 5

/** Hands the video key to main, which keeps it in memory for segment decryption. */
export async function applyVideoKey(loginTokens: string[]): Promise<void> {
  const token = loginTokens[VIDEO_KEY_TOKEN_INDEX]

  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('Login response did not include a video key.')
  }

  await window.pathnatya.setVideoKey(token)
}

export function clearVideoKey(): void {
  void window.pathnatya.clearVideoKey()
}
