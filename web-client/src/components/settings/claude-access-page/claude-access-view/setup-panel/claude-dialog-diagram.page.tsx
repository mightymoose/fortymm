import { interactiveElementsIn } from '@/test/read-only'
import { render, screen, type Container } from '@/test/utilities'
import { ClaudeDialogDiagram } from './claude-dialog-diagram'

/** The diagram's root, reached from its caption. It is `aria-hidden`, so no
 * role query reaches it — by design. */
function figureFor(container: Container) {
  const caption = container.queryByText('Where it goes in Claude')
  return caption?.closest('figure') ?? null
}

const scoped = (container: Container) => {
  const getDiagram = () => {
    const figure = figureFor(container)
    if (!figure) throw new Error('No "Where it goes in Claude" diagram.')
    return figure
  }

  return {
    /** The diagram, or null when it isn't rendered. */
    queryDiagram() {
      return figureFor(container)
    },
    /** The diagram, or a throw. */
    getDiagram,
    /** One of the dialog's drawn lines, by its text. */
    queryDiagramLine(text: string | RegExp) {
      return container.queryByText(text)
    },
    /** Every real control the drawing contains. Must always be empty: its
     * boxes and its Connect chip are pictures of Claude's UI, not
     * affordances. */
    getDiagramControls() {
      return interactiveElementsIn(getDiagram())
    },
  }
}

/** Test page-object for `ClaudeDialogDiagram` — a decorative illustration, so
 * its tests are about what it says and what it must *not* put in the
 * accessibility tree. */
export const claudeDialogDiagramPage = {
  render() {
    render(<ClaudeDialogDiagram />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
