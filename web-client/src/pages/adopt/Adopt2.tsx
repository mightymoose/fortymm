import { useId, useState } from 'react'
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

const answers: readonly Answer[] = ['yes', 'no', 'not-mine']

// Option 2: the same cards, but each answer is a radio with its explanation
// under it, and "Save answer" commits it. Slower, and harder to tap the
// wrong answer by mistake.
export function Adopt2({ state }: { state: ScenarioId }) {
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
        <section className="adopt-questions" aria-labelledby="adopt2-title">
          <div className="adopt-questions__head">
            <h2 className="h3" id="adopt2-title">
              Check your players
            </h2>
            <span className="fm-status">
              <Icon name="clock" />
              {adoption.open.length === 1 ? '1 to answer' : `${adoption.open.length} to answer`}
            </span>
          </div>
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
  const id = useId()
  const [picked, setPicked] = useState<Answer | null>(null)
  const name = question.displayName
  const { selfPlayer } = adoption
  return (
    <Card
      title={`Is ${name} you?`}
      subtitle={`Someone played as ${name} on this device before you signed in.`}
      actions={
        <Button
          variant="primary"
          aria-disabled={picked ? undefined : true}
          onClick={() => picked && adoption.answer(question, picked)}
        >
          Save answer
        </Button>
      }
    >
      <fieldset className="fm-choices adopt-choices">
        <legend className="fm-sr">Is {name} you?</legend>
        {answers.map((answer) => {
          const off = answer === 'yes' && !!selfPlayer
          return (
            <label key={answer} className="fm-radio">
              <input
                type="radio"
                name={id}
                value={answer}
                disabled={off}
                checked={picked === answer}
                onChange={() => setPicked(answer)}
                aria-describedby={`${id}-${answer}`}
              />
              <span className="adopt-choice">
                {answerLabels[answer]}
                <span className="fm-help" id={`${id}-${answer}`}>
                  {off && selfPlayer ? yesUnavailable(selfPlayer) : explain(answer, name)}
                </span>
              </span>
            </label>
          )
        })}
      </fieldset>
    </Card>
  )
}
