export const PHONE_NUMBER_MIN_LENGTH = 9
export const PHONE_NUMBER_MAX_LENGTH = 10
export const PHONE_NUMBER_PATTERN = new RegExp(
  `^\\d{${PHONE_NUMBER_MIN_LENGTH},${PHONE_NUMBER_MAX_LENGTH}}$`
)

export function isValidPhoneNumber(value: string): boolean {
  const digits = value.trim()
  return (
    digits.length >= PHONE_NUMBER_MIN_LENGTH &&
    digits.length <= PHONE_NUMBER_MAX_LENGTH &&
    PHONE_NUMBER_PATTERN.test(digits)
  )
}

export function sanitizePhoneInput(value: string): string {
  return value.replace(/\D/g, '').slice(0, PHONE_NUMBER_MAX_LENGTH)
}
