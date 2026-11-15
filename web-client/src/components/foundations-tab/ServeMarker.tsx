import './ServeMarker.css'

// The design system's serve marker (.serve-marker): a dot beside the player
// who serves. A shape with no word, so it is an image named "Serving".
export function ServeMarker() {
  return <span className="serve-marker" role="img" aria-label="Serving" />
}
