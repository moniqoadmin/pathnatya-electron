/** Position of the AES-128 video key inside the `/accounts/login-token` key list. */
//dummyKey skipped: using a hardcoded key instead of login-token index 5
// const VIDEO_KEY_TOKEN_INDEX = 5

//dummyKey AES-128 hex key used for video decrypt instead of login-token[5]
const DUMMY_VIDEO_KEY = 'af32bea155924d43f9b9755e722bb7ae'

/** Hands the video key to main, which keeps it in memory for segment decryption. */
export async function applyVideoKey(_loginTokens: string[]): Promise<void> {
  //dummyKey ignore login-token API 5th key
  const token = DUMMY_VIDEO_KEY

  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('629 : Login response did not include a video key.')
  }

  await window.pathnatya.setVideoKey(token)
}

export function clearVideoKey(): void {
  void window.pathnatya.clearVideoKey()
}
