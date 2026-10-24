import { CodeForm, EmailForm, LoginOptions, Wordmark } from './loginSteps'
import { useLoginStep } from './useLoginStep'
import './login.css'

const recent = [
  { winner: 'Ama Okafor', loser: 'Jonas Berg', games: '3–1', when: 'Today, 19:10' },
  { winner: 'Lin Wei', loser: 'Ama Okafor', games: '3–2', when: 'Tue, 20:05' },
  { winner: 'Ama Okafor', loser: 'Priya Nair', games: '3–0', when: 'Sat, 11:40' },
]

// Option 2: the form beside a preview of what a log in keeps, a player's
// recent matches. The preview stacks under the form on a phone.
export function Login2() {
  const { step, sendCode, changeEmail } = useLoginStep()
  return (
    <main className="login">
      <LoginOptions />
      <div className="login-split">
        <div className="login-column login-column--start">
          <Wordmark />
          <header className="login-head">
            <h1>{step.kind === 'email' ? 'Log in' : 'Check your email'}</h1>
            <p>Your matches, rating and tournaments, on any device.</p>
          </header>
          {step.kind === 'email' ? (
            <EmailForm onSubmit={sendCode} />
          ) : (
            <CodeForm email={step.email} onChangeEmail={changeEmail} />
          )}
        </div>
        <section className="login-preview" aria-labelledby="login-preview-title">
          <div className="login-preview__head">
            <h2 id="login-preview-title">Ama Okafor</h2>
            <span className="meta">
              Rating <span className="num login-preview__rating">1,512</span>{' '}
              <span className="rating-up">▲ +12</span>
            </span>
          </div>
          <ul className="login-matches">
            {recent.map((match) => (
              <li key={match.when}>
                <span className="login-matches__names">
                  <b>{match.winner}</b>
                  <span>{match.loser}</span>
                </span>
                <span className="num login-matches__games">{match.games}</span>
                <span className="meta">{match.when}</span>
              </li>
            ))}
          </ul>
          <p className="meta">Visual only. Example matches.</p>
        </section>
      </div>
    </main>
  )
}
