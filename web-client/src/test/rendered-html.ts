// The **equivalence guard** for a refactor that must not change what a user sees.
//
// A behaviour-preserving refactor claims the rendered output is unchanged. Assertions that
// spell out a few strings and test ids prove far less than that claim — they stay green
// while a wrapper, a class, an `aria-*` or a whole cell quietly moves. This takes the
// component's entire DOM, so an inline snapshot of it reds on *any* rendered difference,
// however small.
//
// The one thing normalized away is React's generated ids (`useId` — `_r_0_` on React 19.2,
// `«r0»`/`:r0:` in other versions). They are an implementation detail of render order, not something a
// user or a screen reader ever sees as a value: what matters is that the two ends of an
// `aria-labelledby` still point at each other, which is an *accessible-name* assertion
// (`getByRole('region', { name: … })`) and belongs beside the snapshot, not inside it.
// Left un-normalized they would make the snapshot fragile against unrelated renders.

/** Every React-generated id: the React 19.2 (`_r_0_`, `_r_1a_`), the `«r0»` and the older
 * `:r0:` spelling. */
const REACT_GENERATED_ID = /_r_[0-9a-z_]*_|«[^»]+»|:r[0-9a-z]+:/g

/**
 * An element's whole rendered DOM as a string, with React's generated ids replaced by a
 * stable placeholder — for a `toMatchInlineSnapshot()` equivalence guard.
 *
 * Pin it **before** the refactor, on the untouched code, and it will red on any DOM, text,
 * class, attribute or test-id change the refactor causes.
 */
export function renderedHtml(element: HTMLElement): string {
  return element.outerHTML.replace(REACT_GENERATED_ID, 'ID')
}
