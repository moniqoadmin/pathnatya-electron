const CODED_ERROR_PATTERN = /^\d{3,4}\s*:\s*/u
const CODED_ERROR_IN_TEXT = /(\d{3,4}\s*:\s*\S[\s\S]*)$/u

export function isCodedError(message: string): boolean {
  return CODED_ERROR_PATTERN.test(message.trim())
}

/** Pulls a `1234 : …` support code out of IPC wrappers. */
export function extractCodedError(message: string): string | null {
  const trimmed = message.trim()
  if (isCodedError(trimmed)) {
    return trimmed
  }

  const match = trimmed.match(CODED_ERROR_IN_TEXT)
  return match ? match[1].trim() : null
}

/** Formats a stable support code without adding a second code to propagated errors. */
export function userError(code: number, message: string): string {
  const normalized = message.trim()
  return isCodedError(normalized) ? normalized : `${code} : ${normalized}`
}
