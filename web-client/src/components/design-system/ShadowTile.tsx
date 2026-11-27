// A tile showing one shadow on the Foundations board, named after its token (e.g. shadow-overlay).
export function ShadowTile({ token }: { token: string }) {
  return (
    <div className="sw" style={{ width: 160 }}>
      <i
        style={{
          height: 80,
          background: 'var(--bg-group)',
          boxShadow: `var(--${token})`,
          border: '1px solid var(--border-control)',
        }}
      ></i>
      <b>{token}</b>
    </div>
  )
}
