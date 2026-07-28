/**
 * A miniature of Claude's "Add custom connector" dialog, so a player can match
 * the two values on this page to the boxes they're about to see — in
 * particular the client id, which lives behind a disclosure most people never
 * open, and the secret field they must leave alone.
 *
 * **Entirely `aria-hidden`.** Every fact it carries is already stated in the
 * steps' prose, and its "fields" and its Connect button are *drawings*: adding
 * them to the accessibility tree would offer a screen-reader user three
 * controls that do nothing, and two labels that read as this page's own. For
 * the same reason nothing in here is a real `<button>` or `<input>`.
 */
export function ClaudeDialogDiagram() {
  return (
    <figure className="fmm-claude__diagram" aria-hidden="true">
      <figcaption className="fmm-claude__diagram-caption">
        Where it goes in Claude
      </figcaption>
      <div className="fmm-claude__dialog">
        <p className="fmm-claude__dialog-row">
          <span className="fmm-claude__dialog-num">1</span>
          <span className="fmm-claude__dialog-field">
            Remote MCP server URL
          </span>
        </p>
        <p className="fmm-claude__dialog-disclosure">▾ Advanced settings</p>
        <p className="fmm-claude__dialog-row">
          <span className="fmm-claude__dialog-num">2</span>
          <span className="fmm-claude__dialog-field">OAuth client ID</span>
        </p>
        <p className="fmm-claude__dialog-row">
          <span className="fmm-claude__dialog-num fmm-claude__dialog-num--none" />
          <span className="fmm-claude__dialog-field fmm-claude__dialog-field--blank">
            OAuth client secret — leave blank
          </span>
        </p>
        <p className="fmm-claude__dialog-row">
          <span className="fmm-claude__dialog-num">3</span>
          <span className="fmm-claude__dialog-chip">Connect</span>
        </p>
      </div>
    </figure>
  )
}
