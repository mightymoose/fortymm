import { Link } from '@tanstack/react-router'

// The design system's main board (requirements/design-system/reference/Main.dc.html): the showcase
// title, the links to every board, and the Foundations section. Headings are copied from the board.
export function DesignSystemMainScreen() {
  return (
    <main>
      <header>
        <h1>FortyMM component showcase</h1>
        <nav aria-label="Showcase sections">
          <Link to="/design-system">Foundations</Link>
          <Link to="/design-system/roles">Roles and buttons</Link>
          <Link to="/design-system/forms">Fields and selection</Link>
          <Link to="/design-system/containers">Containers and feedback</Link>
          <Link to="/design-system/overlays">Overlays</Link>
          <Link to="/design-system/match">Match components</Link>
          <Link to="/design-system/more">More components</Link>
          <Link to="/design-system/states">State matrix</Link>
        </nav>
      </header>
      <section>
        <h2>Foundations</h2>
      </section>
    </main>
  )
}
