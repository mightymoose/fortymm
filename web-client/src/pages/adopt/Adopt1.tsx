import { useId } from 'react'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { Icon } from '../../components/Icon'
import { Home } from '../Home'
import {
  answerLabels,
  explain,
  signInMessage,
  useAdoption,
  yesUnavailable,
  type Adoption,
} from './adoption'
import { AnsweredNotices, MockupBar } from './parts'
import type { Answer, Question, ScenarioId } from './scenarios'

// Option 1: a card for each open question at the top of Home. The card
// explains every answer, and its buttons answer at once.
export function Adopt1({ state }: { state: ScenarioId }) {
  const adoption = useAdoption(state)
  const message = signInMessage(adoption.scenario.signIn, adoption.scenario.questions)
  return (
    <div className="adopt">
      <MockupBar state={state} />
      {message && (
        <p className="fm-notice fm-notice--success">
          <Icon name="check" />
          <span>{message}</span>
        </p>
      )}
      {adoption.open.length > 0 && (
        <section className="adopt-questions" aria-labelledby="adopt1-title">
          <h2 className="h3" id="adopt1-title">
            Check your players
          </h2>
          {adoption.open.map((question) => (
            <QuestionCard key={question.playerId} question={question} adoption={adoption} />
          ))}
        </section>
      )}
      <AnsweredNotices done={adoption.done} />
      <Home />
    </div>
  )
}

function QuestionCard({ question, adoption }: { question: Question; adoption: Adoption }) {
  const reasonId = useId()
  const name = question.displayName
  const { selfPlayer } = adoption
  const rows: { answer: Answer; text: string }[] = [
    { answer: 'yes', text: selfPlayer ? yesUnavailable(selfPlayer) : explain('yes', name) },
    { answer: 'no', text: explain('no', name) },
    { answer: 'not-mine', text: explain('not-mine', name) },
  ]
  return (
    <Card
      title={`Is ${name} you?`}
      subtitle={`Someone played as ${name} on this device before you signed in.`}
      actions={
        <>
          <Button
            variant="primary"
            aria-disabled={selfPlayer ? true : undefined}
            aria-describedby={selfPlayer ? reasonId : undefined}
            onClick={() => adoption.answer(question, 'yes')}
          >
            {answerLabels.yes}
          </Button>
          <Button variant="secondary" onClick={() => adoption.answer(question, 'no')}>
            {answerLabels.no}
          </Button>
          <Button variant="ghost" onClick={() => adoption.answer(question, 'not-mine')}>
            {answerLabels['not-mine']}
          </Button>
        </>
      }
    >
      <dl className="adopt-answers">
        {rows.map(({ answer, text }) => (
          <div key={answer} data-off={answer === 'yes' && !!selfPlayer}>
            <dt>{answerLabels[answer]}</dt>
            <dd id={answer === 'yes' ? reasonId : undefined}>{text}</dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}
