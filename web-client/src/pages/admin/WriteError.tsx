import { ApiError, classifyFailure, failureMessages } from '../../api/errors'
import { Icon } from '../../components/Icon'

// Why a write failed, as an error alert in the form or dialog that sent it.
// A refusal says the API's own title, such as that no account would keep
// the permission to grant roles.
export function WriteError({ error }: { error: unknown }) {
  const failure = classifyFailure(error)
  const refused =
    error instanceof ApiError && error.title !== null && failure.kind === 'broken' && error.status < 500
  const title = refused ? error.title : failureMessages[failure.kind].title
  return (
    <div className="fm-alert fm-alert--error" role="alert">
      <Icon name="error" />
      <p className="fm-alert__title">{title}</p>
      {!refused && (
        <p className="fm-alert__body">
          Your change wasn’t saved.{' '}
          {failure.kind === 'unreachable'
            ? 'Check your connection, then try again.'
            : 'Try again. If it keeps happening, tell us what you were doing.'}
        </p>
      )}
    </div>
  )
}
