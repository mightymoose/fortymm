import { useSearch } from '@tanstack/react-router'
import { MatchList } from './browse/MatchLists'
import { PrototypeBar } from './browse/parts'
import { LIST_LABELS } from './browse/variants'
import './browse/browse.css'

// The matches page: three prototype layouts of the viewer's matches,
// picked with `?variant=a|b|c`.
export function Matches() {
  const { variant = 'a' } = useSearch({ from: '/_authenticated/_shell/matches/' })
  return (
    <>
      <h1>Matches</h1>
      <PrototypeBar variant={variant} labels={LIST_LABELS} />
      <MatchList variant={variant} />
    </>
  )
}
