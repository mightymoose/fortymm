import { useState } from 'react'

// The log in mockups' two steps. Nothing is sent: "Email me a code" only
// moves the page to the code step, and "Log in" says it isn't wired up.
export type LoginStep = { kind: 'email' } | { kind: 'code'; email: string }

export function useLoginStep() {
  const [step, setStep] = useState<LoginStep>({ kind: 'email' })
  return {
    step,
    sendCode: (email: string) => setStep({ kind: 'code', email }),
    changeEmail: () => setStep({ kind: 'email' }),
  }
}
