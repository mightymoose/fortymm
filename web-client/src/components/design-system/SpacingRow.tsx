// A step of the Foundations board's spacing scale: its label beside a bar as wide as the step.
// The bar takes its width from the token (e.g. --s-4), so a missing or wrong token shows.
export function SpacingRow({ token, size }: { token: string; size: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <span className="num" style={{ width: 72, fontSize: 12, color: 'var(--fg-3)' }}>
        {token} · {size}
      </span>
      <i
        style={{
          display: 'block',
          height: 12,
          width: `var(--${token})`,
          background: 'var(--chalk-300)',
          borderRadius: 2,
        }}
      ></i>
    </div>
  )
}
