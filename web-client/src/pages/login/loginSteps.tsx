import { Link } from '@tanstack/react-router'
import { useId, useState, type FormEvent } from 'react'
import { Button, type ButtonSize } from '../../components/Button'
import { CodeInput } from '../../components/CodeInput'
import { FieldError } from '../../components/FieldError'
import { DemoButton } from '../designSystem/DemoButton'

export function EmailForm({
  size = 'lg',
  onSubmit,
}: {
  size?: ButtonSize
  onSubmit: (email: string) => void
}) {
  const id = useId()
  const [invalid, setInvalid] = useState(false)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const email = String(new FormData(event.currentTarget).get('email')).trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setInvalid(true)
      return
    }
    onSubmit(email)
  }

  return (
    <form className="login-form" noValidate onSubmit={submit}>
      <div className="fm-field">
        <label className="fm-label" htmlFor={`${id}-email`}>
          Email
        </label>
        <input
          className="fm-input"
          id={`${id}-email`}
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          aria-invalid={invalid || undefined}
          aria-describedby={`${id}-help ${id}-error`}
          onInput={() => setInvalid(false)}
        />
        <p className="fm-help" id={`${id}-help`}>
          We email you a 6-digit code. No password to remember.
        </p>
        <FieldError id={`${id}-error`} hidden={!invalid}>
          Enter an email address, like you@example.com.
        </FieldError>
      </div>
      <Button variant="primary" size={size} type="submit" className="fm-btn--block">
        Email me a code
      </Button>
    </form>
  )
}

export function CodeForm({
  email,
  size = 'lg',
  onChangeEmail,
}: {
  email: string
  size?: ButtonSize
  onChangeEmail: () => void
}) {
  const id = useId()
  return (
    <div className="login-form">
      <div className="fm-field">
        <span className="fm-label" id={`${id}-label`}>
          Code
        </span>
        <p className="fm-help" id={`${id}-help`}>
          We sent a 6-digit code to <b className="login-email">{email}</b>. It
          works for 10 minutes.
        </p>
        <CodeInput aria-labelledby={`${id}-label`} describedBy={`${id}-help`} />
      </div>
      <DemoButton variant="primary" size={size} className="fm-btn--block">
        Log in
      </DemoButton>
      <div className="login-row">
        <Button variant="link" onClick={onChangeEmail}>
          Use a different email
        </Button>
        <DemoButton variant="link">Send a new code</DemoButton>
      </div>
    </div>
  )
}

// Links between the mockups, so reviewers can compare them.
export function LoginOptions() {
  return (
    <nav className="login-options" aria-label="Log in options">
      <span>Mockup</span>
      <Link to="/login1">Option 1</Link>
      <Link to="/login2">Option 2</Link>
      <Link to="/login3">Option 3</Link>
      <Link to="/login4">Option 4</Link>
    </nav>
  )
}

export function Wordmark() {
  return (
    <span className="login-wordmark">
      <span className="login-wordmark__ball" aria-hidden="true" />
      FortyMM
    </span>
  )
}
