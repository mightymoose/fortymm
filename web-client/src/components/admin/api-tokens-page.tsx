import { useState } from 'react'
import { Check, Copy, KeyRound, TriangleAlert } from 'lucide-react'
import { useCreateApiToken } from '@/api/api-tokens'
import { useHasPermission, useSession } from '@/api/session'
import { PERM } from '@/lib/permissions'
import { ApiError } from '@/api/client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

/**
 * The Administration area's **API-token** page. The section itself is fronted by
 * the nav's `administration.view` gate (app-shell) and the admin
 * `RbacBoundary`; this page adds the finer gate the feature actually turns on —
 * the **Generate** control is shown only to a session that carries
 * `api_token.manage`, exactly the permission the server enforces on
 * `POST /v1/api-tokens`.
 *
 * Hiding the control is a UX decision, never a security boundary: the API 403s
 * the mint endpoint independently. A viewer who can reach the section but lacks
 * the grant sees a brief "you don't have permission" notice instead.
 */
export function ApiTokensPage() {
  const { isPending } = useSession()
  const canManage = useHasPermission(PERM.API_TOKEN_MANAGE)
  // `useHasPermission` reads false while the session is in flight; wait it out
  // so an authorized user never flashes the no-permission notice.
  if (isPending) return null

  return (
    <div className="mx-auto max-w-[720px] px-12 pt-16 pb-32">
      <header className="mb-8">
        <h1 className="font-display text-4xl text-foreground">API tokens</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Mint a personal bearer token to call the FortyMM API on your own
          behalf.
        </p>
      </header>
      {canManage ? <ApiTokenGenerator /> : <NoPermissionNotice />}
    </div>
  )
}

/** Shown to a user who reached the section but lacks `api_token.manage`. Copy is
 * specific to this grant (the admin `AccessDenied` is section-wide), so a viewer
 * who can see the rest of Administration understands exactly what is missing. */
function NoPermissionNotice() {
  return (
    <Alert>
      <KeyRound />
      <AlertTitle>You don't have permission to create API tokens</AlertTitle>
      <AlertDescription>
        Ask an administrator to grant you the <code>api_token.manage</code>{' '}
        permission.
      </AlertDescription>
    </Alert>
  )
}

/** The Generate control + one-time reveal. Only mounted once the gate confirms
 * `api_token.manage`, so its mutation never 403s. */
function ApiTokenGenerator() {
  const create = useCreateApiToken()
  const [token, setToken] = useState<string | null>(null)

  const error = create.isError
    ? create.error instanceof ApiError && create.error.detail
      ? create.error.detail
      : "Couldn't create a token. Try again."
    : null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Personal API token</CardTitle>
        <CardDescription>
          You can have one active token at a time. Generating a new token
          immediately invalidates the previous one.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div>
          <Button
            type="button"
            onClick={() =>
              create.mutate(undefined, {
                onSuccess: (result) => setToken(result.token),
              })
            }
            disabled={create.isPending}
          >
            <KeyRound />
            {token ? 'Regenerate token' : 'Generate token'}
          </Button>
        </div>

        {error && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>{error}</AlertTitle>
          </Alert>
        )}

        {token && <TokenReveal token={token} />}
      </CardContent>
    </Card>
  )
}

/** The raw token, shown exactly once, with the password caution and a copy
 * affordance. */
function TokenReveal({ token }: { token: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(token)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked (permissions / insecure context): the token is still
      // visible for a manual copy, so there is nothing to surface.
    }
  }

  return (
    <Alert variant="destructive" aria-label="Your new API token">
      <TriangleAlert />
      <AlertTitle>Copy your token now — it won't be shown again</AlertTitle>
      <AlertDescription>
        <p>
          Treat this like a password. This is the only time we'll show it; if you
          lose it, generate a new one (which invalidates this one).
        </p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs text-foreground">
            {token}
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={copy}
            aria-label="Copy token"
          >
            {copied ? <Check /> : <Copy />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}
