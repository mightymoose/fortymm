import { Icon } from '../../../components/Icon'

// Says the matches are samples, until the API lists real ones.
export function SampleNotice() {
  return (
    <p className="fm-notice match-sample">
      <Icon name="info" />
      <span>These are sample matches. Real matches show here once the API lists them.</span>
    </p>
  )
}
