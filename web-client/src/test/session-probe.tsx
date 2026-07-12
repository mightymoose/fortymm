import { useSession } from '@/api/session'

/**
 * A test-only marker that appears once `/v1/session` has resolved.
 *
 * Permission-gated UI that renders **nothing** when unauthorized is a trap to
 * assert on: `useHasPermission` also reads `false` while the session is still in
 * flight, so a bare "expect the control to be absent" passes during loading and
 * proves nothing. Render this alongside the component under test and `await` the
 * marker first — then the absence is a real absence.
 */
export function SessionProbe() {
  const { data } = useSession()
  return data ? <span data-testid="session-ready" /> : null
}
