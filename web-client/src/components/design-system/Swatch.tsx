// A colour swatch from the Foundations board: the colour as a chip, its name, and its value.
export function Swatch({ color, name, value }: { color: string; name: string; value: string }) {
  return (
    <div className="sw">
      <i style={{ background: `var(${color})` }}></i>
      <b>{name}</b>
      <span>{value}</span>
    </div>
  )
}
