import { useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { z } from 'zod'

import { ApiError } from '@/api/client'
import {
  type MergePreview,
  useConsumeLoginToken,
  useMergePreview,
} from '@/api/session'
import { btnGhost, btnPrimary, fineprint } from '@/components/login/styles'
import { LinkCheckPage } from '@/components/login/link-check-page/link-check-page'
import { ScreenVerifyNetError } from '@/components/login/login-screens'
import { MergeGate } from '@/components/login/merge-gate'
import { pageTitle } from '@/lib/page-title'

type VerifyError = 'expired' | 'net' | 'replaced' | 'email_changed'

const VERIFY_ERRORS = new Set<VerifyError>([
  'expired',
  'net',
  'replaced',
  'email_changed',
])

// `POST /v1/login/consume`'s 400 body, `{ detail: { code, message } }` —
// `consume_login_token`'s three coded reasons (#1466 defect 3). NOT declared
// on the route's OpenAPI `responses=` (matches the existing
// `session_merged`/`session_ended` precedent in client.ts), so it never
// reaches `schema.d.ts` — read off `ApiError.body`, never off the typed
// `ApiError.detail` (a bare `string | null`), and parse it here.
const loginConsumeErrorSchema = z.object({
  detail: z.object({ code: z.string(), message: z.string() }),
})

/** The structured `code` a 4xx from `/login/consume` carries, or `null` when
 * the body doesn't parse as the coded shape (a plain-string detail, no body,
 * or an unrecognized error). `null` maps to the safe `'expired'` fallback —
 * today's behaviour for every other 4xx. */
function loginConsumeErrorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null
  const parsed = loginConsumeErrorSchema.safeParse(err.body)
  return parsed.success ? parsed.data.detail.code : null
}

export const Route = createFileRoute('/login/verifying')({
  head: () => ({
    meta: [{ title: pageTitle('Verifying') }],
  }),
  validateSearch: (search: Record<string, unknown>) => {
    const e = search.error
    // A duplicated `?token=a&token=b` is parsed into an array. Take the first
    // value so the dedup case behaves like a single (likely-invalid) token and
    // surfaces the generic invalid-link error, not a misleading "missing token".
    const raw = Array.isArray(search.token) ? search.token[0] : search.token
    return {
      token: typeof raw === 'string' ? raw : '',
      error:
        typeof e === 'string' && VERIFY_ERRORS.has(e as VerifyError)
          ? (e as VerifyError)
          : undefined,
    }
  },
  component: LoginVerifyingPage,
})

function LoginVerifyingPage() {
  const { token, error } = Route.useSearch()
  const navigate = useNavigate()
  const preview = useMergePreview()
  const consume = useConsumeLoginToken()
  // Holds the preview only while the cross-device gate is up; everything else
  // (previewing, consuming) renders the same verifying screen.
  const [gate, setGate] = useState<MergePreview | null>(null)
  const fired = useRef(false)

  const runConsume = (skipMerge: boolean) => {
    setGate(null)
    consume.mutate(
      { token, skipMerge },
      {
        onSuccess: (session) => {
          const moved = session.merged?.matches_moved ?? 0
          if (moved > 0) {
            toast.success(
              moved === 1
                ? 'We brought your 1 match with you.'
                : `We brought your ${moved} matches with you.`,
            )
          }
          navigate({ to: '/login/welcome' })
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
            const code = loginConsumeErrorCode(err)
            const nextError: VerifyError =
              code === 'replaced'
                ? 'replaced'
                : code === 'email_changed'
                  ? 'email_changed'
                  : 'expired'
            navigate({
              to: '/login/verifying',
              search: { token: '', error: nextError },
            })
          } else {
            navigate({ to: '/login/verifying', search: { token, error: 'net' } })
          }
        },
      },
    )
  }

  // Preview first; a merge that would carry matches over waits at the gate,
  // everything else signs in straight away. We don't cancel from cleanup so
  // StrictMode's simulated unmount can't strand an in-flight request.
  useEffect(() => {
    if (fired.current || !token || error) return
    fired.current = true
    preview.mutate(token, {
      onSuccess: (p) => {
        if (p.is_merge && p.guest_matches_count > 0) {
          setGate(p)
        } else {
          runConsume(false)
        }
      },
      onError: () => runConsume(false),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, error])

  const sendNewLink = () =>
    navigate({ to: '/login', search: { error: undefined, email: undefined } })

  const sendNewLinkButton = (
    <button
      type="button"
      style={{ ...btnPrimary, width: '100%' }}
      onClick={sendNewLink}
    >
      Send a new link
    </button>
  )

  // The `replaced` state's screen must NOT offer "Send a new link" as its
  // main action — that would kill the newer link the copy just told the user
  // to open (#1466 defect 3, acceptance criteria). Guidance text plus a
  // demoted secondary action instead of the primary CTA every other error
  // state uses.
  const replacedFooter = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={{ ...fineprint, textAlign: 'center', marginTop: 0 }}>
        Look for the most recent sign-in email — that link is still live.
      </p>
      <button
        type="button"
        style={{ ...btnGhost, width: '100%' }}
        onClick={sendNewLink}
      >
        Send a new link instead
      </button>
    </div>
  )

  if (!token && !error) {
    return <LinkCheckPage state="missing" footer={sendNewLinkButton} />
  }

  if (error === 'expired') {
    return <LinkCheckPage state="expired" footer={sendNewLinkButton} />
  }

  if (error === 'email_changed') {
    return <LinkCheckPage state="email_changed" footer={sendNewLinkButton} />
  }

  if (error === 'replaced') {
    return <LinkCheckPage state="replaced" footer={replacedFooter} />
  }

  if (error === 'net') {
    return (
      <ScreenVerifyNetError
        retrying={consume.isPending}
        onRetry={() => {
          fired.current = false
          setGate(null)
          navigate({ to: '/login/verifying', search: { token, error: undefined } })
        }}
        onSendNewLink={() =>
          navigate({ to: '/login', search: { error: undefined, email: undefined } })
        }
      />
    )
  }

  if (gate) {
    return (
      <MergeGate
        ownerUsername={gate.owner_username ?? ''}
        guestUsername={gate.guest_username ?? null}
        matchesCount={gate.guest_matches_count}
        adoptsGuestUsername={gate.adopts_guest_username}
        busy={consume.isPending}
        onBringThemOver={() => runConsume(false)}
        onNotNow={() => runConsume(true)}
      />
    )
  }

  return <LinkCheckPage state="checking" />
}
