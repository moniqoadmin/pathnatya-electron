import { InputHTMLAttributes, useState } from 'react'

interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  id: string
}

export default function PasswordInput({ id, disabled, ...props }: PasswordInputProps) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="password-field">
      <input id={id} type={visible ? 'text' : 'password'} disabled={disabled} {...props} />
      <button
        type="button"
        className="password-toggle"
        onClick={() => setVisible((current) => !current)}
        disabled={disabled}
        aria-label={visible ? 'Hide password' : 'Show password'}
      >
        {visible ? (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27 3.28 5.55l18.17 18.17L22.73 22 21.45 20.72l-2.05-2.05C19.27 17.89 21.73 15.73 23 13c-.96-2.43-2.79-4.47-5.14-5.7L18.9 4.9 17.8 3.8 14.16 7.44C13.47 7.16 12.75 7 12 7c-.75 0-1.47.16-2.16.44L9.9 6.5 8.8 7.61l1.73 1.73C8.21 10.37 4.83 12.5 3.18 15.87l1.93 1.93L2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78 3.15 3.15"
            />
          </svg>
        )}
      </button>
    </div>
  )
}
