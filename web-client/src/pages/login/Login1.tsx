import { CodeForm, EmailForm, LoginOptions, Wordmark } from './loginSteps'
import { useLoginStep } from './useLoginStep'
import './login.css'

// Option 1: one centred column. The form is the only thing on the page.
export function Login1() {
  const { step, sendCode, changeEmail } = useLoginStep()
  return (
    <main className="login">
      <LoginOptions />
      <div className="login-column">
        <Wordmark />
        <header className="login-head">
          <h1>{step.kind === 'email' ? 'Log in' : 'Check your email'}</h1>
          <p>Keep your matches and rating on every device.</p>
        </header>
        {step.kind === 'email' ? (
          <EmailForm onSubmit={sendCode} />
        ) : (
          <CodeForm email={step.email} onChangeEmail={changeEmail} />
        )}
        <p className="meta">FortyMM is free. We don't show ads.</p>
      </div>
    </main>
  )
}
