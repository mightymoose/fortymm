import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { CodeForm, EmailForm, LoginOptions } from './loginSteps'
import { useLoginStep } from './useLoginStep'
import './login.css'

// Option 4: phone first, for logging in at the table. One question per
// screen, a back button, and extra-large targets.
export function Login4() {
  const { step, sendCode, changeEmail } = useLoginStep()
  return (
    <main className="login">
      <LoginOptions />
      <div className="login-column login-column--phone">
        {step.kind === 'code' && (
          <div className="login-bar">
            <Button variant="ghost" icon aria-label="Back" onClick={changeEmail}>
              <Icon name="left" />
            </Button>
          </div>
        )}
        <header className="login-head">
          <h1>{step.kind === 'email' ? 'How do you want to log in?' : 'Enter your code'}</h1>
          <p>
            {step.kind === 'email'
              ? 'Log in to keep your matches and rating on every device.'
              : 'Open the email from FortyMM on any device.'}
          </p>
        </header>
        {step.kind === 'email' ? (
          <EmailForm size="xl" onSubmit={sendCode} />
        ) : (
          <CodeForm email={step.email} size="xl" onChangeEmail={changeEmail} />
        )}
      </div>
    </main>
  )
}
