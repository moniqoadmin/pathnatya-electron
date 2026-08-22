export const PHONE_NUMBER_MAX_LENGTH = 10
export const PHONE_NUMBER_PATTERN = /^\d{9,10}$/

export function isValidPhoneNumber(value: string): boolean {
  return PHONE_NUMBER_PATTERN.test(value.trim())
}

export function sanitizePhoneInput(value: string): string {
  return value.replace(/\D/g, '').slice(0, PHONE_NUMBER_MAX_LENGTH)
}
