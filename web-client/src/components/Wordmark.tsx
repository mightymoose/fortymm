// The FortyMM wordmark of the app's frames, styled by `.app-wordmark` in
// styles/base.css.
export function Wordmark() {
  return (
    <span className="app-wordmark" role="img" aria-label="FortyMM">
      <span className="app-wordmark__ball" />
      <span className="app-wordmark__name">FortyMM</span>
    </span>
  )
}
