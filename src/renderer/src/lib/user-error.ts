const CODED_ERROR_PATTERN = /^\d{3,4}\s*:\s*/u

/** Formats a stable support code without adding a second code to propagated errors. */
export function userError(code: number, message: string): string {
  const normalized = message.trim()
  return CODED_ERROR_PATTERN.test(normalized) ? normalized : `${code} : ${normalized}`
}
