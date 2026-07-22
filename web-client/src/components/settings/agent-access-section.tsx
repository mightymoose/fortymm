import { useQuery } from '@tanstack/react-query'
import { Bot, Check } from 'lucide-react'
import { toast } from 'sonner'

import {
  auth0LinkQueryOptions,
  auth0LinkStartUrl,
  useUnlinkAuth0,
} from '@/api/auth0'
import { ApiError } from '@/api/client'
import { useHasPermission, useSession } from '@/api/session'
import { PERM } from '@/lib/permissions'

/**
 * The Settings page's **Agent access** section — the Auth0 identity link that
 * lets an AI agent reach the MCP server on the user's behalf.
 *
 * The whole section is gated on `mcp.access`: a user without the grant sees
 * nothing at all. Hiding it is a UX decision, never a security boundary — the
 * API independently enforces the same permission on `/v1/auth0/link*`.
 *
 * `useHasPermission` reads `false` while the session is still loading, so we wait
 * the session out (`isPending`) before deciding, exactly like `ApiTokensPage` —
 * otherwise a permitted user would flash an empty section on first paint.
 */
export function AgentAccessSection() {
  const { isPending: sessionPending } = useSession()
  const canAccess = useHasPermission(PERM.MCP_ACCESS)
  const status = useQuery({
    ...auth0LinkQueryOptions(),
    // Don't fetch link status for a user who will never see the section.
    enabled: canAccess,
  })
  const unlink = useUnlinkAuth0()

  if (sessionPending || !canAccess) return null

  const onUnlink = async () => {
    try {
      await unlink.mutateAsync()
      toast.success('Agent access disconnected.')
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.detail
          ? err.detail
          : "Couldn't disconnect agent access. Try again.",
      )
    }
  }

  return (
    <section
      id="sec-agent-access"
      className="fmm-card"
      aria-labelledby="agent-access-title"
      data-screen-label="04 Agent access"
    >
      <header style={{ padding: '24px 28px 0' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginBottom: 6,
          }}
        >
          <span className="fmm-section-num">04</span>
          <span className="fmm-overline" style={{ color: 'var(--fg-muted)' }}>
            Integrations
          </span>
          {status.data?.linked && (
            <span className="fmm-tag fmm-tag--ok">Connected</span>
          )}
        </div>
        <h2
          id="agent-access-title"
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 'var(--text-xl)',
            fontWeight: 600,
            letterSpacing: '-0.01em',
            color: 'var(--fg-1)',
            margin: '0 0 6px',
          }}
        >
          Agent access
        </h2>
        <p
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--fg-3)',
            margin: 0,
            maxWidth: 560,
            lineHeight: 'var(--lh-snug)',
          }}
        >
          Connect an Auth0 identity so an AI agent can act on your behalf through
          the FortyMM MCP server. You can disconnect it any time.
        </p>
      </header>
      <div className="fmm-card-body" style={{ padding: '24px 28px 28px' }}>
        {status.isPending ? (
          <div className="fmm-help" role="status">
            <span className="fmm-spinner" /> Checking connection…
          </div>
        ) : status.isError ? (
          <div className="fmm-help fmm-help--err" role="status">
            Couldn't load your agent-access status. Reload to try again.
          </div>
        ) : status.data.linked ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '14px 16px',
              background: 'rgba(0,226,154,0.06)',
              border: '1px solid rgba(0,226,154,0.3)',
              borderRadius: 'var(--r-md)',
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                background: 'rgba(0,226,154,0.18)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Check size={16} color="var(--serve-500)" />
            </div>
            <div
              style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}
            >
              <div style={{ fontWeight: 600, color: 'var(--fg-1)' }}>
                Agent access is connected.
              </div>
              <div style={{ color: 'var(--fg-3)', marginTop: 2 }}>
                An agent signed in with your linked identity can reach the MCP
                server on your behalf.
              </div>
            </div>
            <button
              type="button"
              className="fmm-btn fmm-btn--quiet fmm-btn--sm"
              onClick={onUnlink}
              disabled={unlink.isPending}
            >
              {unlink.isPending ? (
                <>
                  <span className="fmm-spinner" /> Disconnecting…
                </>
              ) : (
                'Unlink'
              )}
            </button>
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '14px 16px',
              background: 'var(--bg-panel)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--r-md)',
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                background: 'var(--bg-elev)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Bot size={16} color="var(--fg-muted)" />
            </div>
            <div
              style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--fg-2)' }}
            >
              <div style={{ fontWeight: 600, color: 'var(--fg-1)' }}>
                No agent access connected.
              </div>
              <div style={{ color: 'var(--fg-3)', marginTop: 2 }}>
                Connect an Auth0 identity to let an agent act for you.
              </div>
            </div>
            {/* A full-page navigation, not a fetch — this begins an OAuth
                redirect the API answers with a 302 (see `auth0LinkStartUrl`). */}
            <a
              className="fmm-btn fmm-btn--primary fmm-btn--sm"
              href={auth0LinkStartUrl()}
            >
              Connect
            </a>
          </div>
        )}
      </div>
    </section>
  )
}
