import { useState } from 'react'
import {
  scenarios,
  type Answer,
  type Question,
  type Scenario,
  type ScenarioId,
  type SignIn,
} from './scenarios'

export const answerLabels: Record<Answer, string> = {
  yes: 'Yes',
  no: 'No, it is someone else',
  'not-mine': 'Not mine',
}

// What each answer does, said before the person picks it.
export function explain(answer: Answer, name: string): string {
  switch (answer) {
    case 'yes':
      return `${name} becomes your player. You play and enter tournaments as ${name}.`
    case 'no':
      return `${name} stays on your account as a player you manage, such as a child who played on this device.`
    case 'not-mine':
      return `We take ${name} off your account. Use this if someone else used this device, such as a shared computer.`
  }
}

// Why "Yes" is off while the account already has its own player. Combining
// two players needs player merge, which comes with games.
export function yesUnavailable(selfPlayer: string): string {
  return `You already play as ${selfPlayer}. We can’t combine two players yet.`
}

// What the page says once an answer is saved.
export function answered(answer: Answer, name: string): string {
  switch (answer) {
    case 'yes':
      return `${name} is your player now.`
    case 'no':
      return `${name} stays on your account as a player you manage.`
    case 'not-mine':
      return `We took ${name} off your account.`
  }
}

export type Adoption = {
  scenario: Scenario
  // The account's own player, after any "Yes".
  selfPlayer: string | null
  open: Question[]
  done: { question: Question; answer: Answer }[]
  answer: (question: Question, answer: Answer) => void
  // Takes the answer back, so the question is open again.
  undo: (question: Question) => void
}

// The page's answers. They change only the page, so a reload asks again.
export function useAdoption(id: ScenarioId): Adoption {
  const scenario: Scenario = scenarios[id]
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  const yes = scenario.questions.find((question) => answers[question.playerId] === 'yes')
  return {
    scenario,
    selfPlayer: scenario.selfPlayer ?? yes?.displayName ?? null,
    open: scenario.questions.filter((question) => !answers[question.playerId]),
    done: scenario.questions.flatMap((question) => {
      const answer = answers[question.playerId]
      return answer ? [{ question, answer }] : []
    }),
    answer: (question, answer) =>
      setAnswers((current) => ({ ...current, [question.playerId]: answer })),
    undo: (question) =>
      setAnswers((current) => {
        const { [question.playerId]: _undone, ...rest } = current
        return rest
      }),
  }
}

// What moved at sign-in, or null on a later visit.
export function signInMessage(signIn: SignIn, questions: readonly Question[]): string | null {
  if (!signIn) return null
  const names = questions.map((question) => question.displayName).join(' and ')
  return signIn.kind === 'adopted'
    ? `You’re signed in as ${signIn.email}. We added ${names} to your account.`
    : `You’re signed in as ${signIn.email}. Your games on this device stay with you.`
}
