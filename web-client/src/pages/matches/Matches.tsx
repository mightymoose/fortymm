import { MatchList } from './browse/MatchList'
import './browse/browse.css'

// The matches page: every match, newest first.
export function Matches() {
  return (
    <>
      <h1>Matches</h1>
      <MatchList />
    </>
  )
}
