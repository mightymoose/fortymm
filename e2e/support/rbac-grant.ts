import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// Grant an RBAC role to a minted user directly in Postgres, over the same
// `docker compose … exec` seam `global-setup` owns the stack through.
//
// Why this exists: a guest/ephemeral user holds only the default `User` role,
// which carries NO permissions. Creating a tournament is gated on
// `tournament.create`, and the one role that carries it — **"Beta tester"**
// (`api/scripts/seed_rbac.py`, which also carries `mcp.access`) — is granted to
// NOBODY by the seed. So a spec that drives the tournament flow as a real
// director has to hand its test user that role first, or the create 403s
// (viewing a published tournament and entering one need no grant, #1092).
// There is no HTTP endpoint to self-assign a role (`authorization.manage`
// is itself an admin-only grant nobody holds), so the sanctioned seam is the
// database, reached the way the suite reaches everything else it manages: the
// composed stack's own `postgres` container.
//
// This is a **stack-management** operation, exactly like `global-setup`'s
// `docker compose up`. When `E2E_BASE_URL` points at a stack this suite does not
// own, it is skipped (there is no compose project to `exec` into) — the caller
// must arrange the grant on that stack itself.

const repoRoot = resolve(__dirname, '..', '..')
const baseFile = resolve(repoRoot, 'docker-compose.dev.yml')
const overrideFile = resolve(repoRoot, 'docker-compose.e2e.yml')

const BETA_TESTER_ROLE = 'Beta tester'

// Auto-minted usernames are alphanumerics plus `.`/`_`/`-`; anything else is not
// a username this suite produces, and letting it reach a `-c` string would be an
// injection. Refuse it rather than quote-escape — the value is always ours.
const SAFE_USERNAME = /^[A-Za-z0-9._-]+$/

/**
 * Grant the **"Beta tester"** role (`tournament.create` + `mcp.access`) to the
 * user with `username`, so a spec can drive the tournament flow as that director.
 *
 * Idempotent — a `WHERE NOT EXISTS` guard means a re-grant inserts nothing, so a
 * retried test is safe. No-op (returns `false`) when `E2E_BASE_URL` is set: the
 * stack is not ours to `exec` into, and the caller owns provisioning there.
 *
 * Throws if the `docker compose … exec psql` fails — a silent grant that did not
 * land would surface far away as an inexplicable 403 on the first tournament write.
 */
export function grantBetaTester(username: string): boolean {
  if (process.env.E2E_BASE_URL) return false
  if (!SAFE_USERNAME.test(username)) {
    throw new Error(`refusing to grant a role to an unexpected username: ${username}`)
  }

  // Resolve the Player username to its primary managing Account, guarded by a
  // NOT EXISTS so the (user_id, role_id) composite PK is never violated on a
  // re-run. No ON CONFLICT target needed, so it does not depend on the
  // constraint's name.
  const sql =
    'INSERT INTO user_roles (user_id, role_id) ' +
    'SELECT a.id, r.id FROM accounts a ' +
    'JOIN account_players ap ON ap.account_id = a.id AND ap.is_primary ' +
    'JOIN players p ON p.id = ap.player_id CROSS JOIN roles r ' +
    `WHERE p.username = '${username}' AND r.name = '${BETA_TESTER_ROLE}' ` +
    'AND a.merged_into_user_id IS NULL AND p.merged_into_player_id IS NULL ' +
    'AND NOT EXISTS (SELECT 1 FROM user_roles ur ' +
    'WHERE ur.user_id = a.id AND ur.role_id = r.id);'

  const result = spawnSync(
    'docker',
    [
      'compose',
      '-f', baseFile,
      '-f', overrideFile,
      'exec', '-T', 'postgres',
      'psql', '-U', 'postgres', '-d', 'fortymm',
      '-v', 'ON_ERROR_STOP=1',
      '-c', sql,
    ],
    { encoding: 'utf-8' },
  )

  if (result.status !== 0) {
    throw new Error(
      `granting "${BETA_TESTER_ROLE}" to ${username} failed ` +
        `(exit ${result.status}): ${result.stderr || result.stdout}`,
    )
  }
  // psql prints the affected-row count ("INSERT 0 1" first run, "INSERT 0 0" on a
  // re-grant); either is success. A username that matched no row (INSERT 0 0 with
  // no prior grant) would be a mis-wired test, but is indistinguishable from an
  // idempotent re-run here — the tournament write's own 403 is the real backstop.
  return true
}
