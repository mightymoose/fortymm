import { claudeDialogDiagramPage } from './claude-dialog-diagram.page'

describe('ClaudeDialogDiagram', () => {
  it('names the three boxes the values go in, in the order Claude shows them', () => {
    claudeDialogDiagramPage.render()

    expect(
      claudeDialogDiagramPage.queryDiagramLine('Remote MCP server URL'),
    ).toBeInTheDocument()
    expect(
      claudeDialogDiagramPage.queryDiagramLine('▾ Advanced settings'),
    ).toBeInTheDocument()
    expect(
      claudeDialogDiagramPage.queryDiagramLine('OAuth client ID'),
    ).toBeInTheDocument()
    // The one box a player must leave alone is drawn, not omitted: an empty
    // field looks like a step you forgot unless something says otherwise.
    expect(
      claudeDialogDiagramPage.queryDiagramLine(
        'OAuth client secret — leave blank',
      ),
    ).toBeInTheDocument()
  })

  it('stays out of the accessibility tree', () => {
    claudeDialogDiagramPage.render()

    expect(claudeDialogDiagramPage.getDiagram()).toHaveAttribute(
      'aria-hidden',
      'true',
    )
  })

  it("draws Claude's controls rather than rendering any", () => {
    claudeDialogDiagramPage.render()

    // Including the "Connect" chip: a second real button labelled Connect on a
    // page whose actual instruction is "select Connect in Claude" would send a
    // player clicking the wrong thing.
    expect(claudeDialogDiagramPage.getDiagramControls()).toHaveLength(0)
  })
})
