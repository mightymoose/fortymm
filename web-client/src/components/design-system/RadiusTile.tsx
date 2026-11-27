// A tile showing one radius on the Foundations board. The corners come from the token (e.g.
// --r-sm), so a missing or wrong token shows.
export function RadiusTile({ token, label, height }: { token: string; label: string; height: number }) {
  return (
    <div className="sw" style={{ width: 120 }}>
      <i style={{ height, borderRadius: `var(--${token})`, background: 'var(--bg-panel)' }}></i>
      <b>{label}</b>
    </div>
  )
}
