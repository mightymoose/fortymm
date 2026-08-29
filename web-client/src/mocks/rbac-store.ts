import type { SeedSpec } from './rbac-engine'

const ALL = [
  'p_tc', 'p_te', 'p_td', 'p_tp',
  'p_dv', 'p_dg', 'p_de', 'p_dp', 'p_dl',
  'p_cv', 'p_ca', 'p_cs', 'p_co',
  'p_pv', 'p_pc', 'p_pe', 'p_pd', 'p_pm',
  'p_rv', 'p_rr',
  'p_mv', 'p_ma', 'p_mr', 'p_rm', 'p_pa',
  'p_sv', 'p_sc', 'p_sx',
]
const VIEW = ['p_dv', 'p_cv', 'p_pv', 'p_rv', 'p_mv', 'p_sv']

export const DEMO_SEED: SeedSpec = {
  permissions: [
    { id: 'p_tc', name: 'tournament.create', description: 'Spin up a new tournament event.' },
    { id: 'p_te', name: 'tournament.edit', description: 'Rename, reschedule, change format.' },
    { id: 'p_td', name: 'tournament.delete', description: 'Permanently remove a tournament.' },
    { id: 'p_tp', name: 'tournament.publish', description: 'Publish a tournament to the spectator view.' },
    { id: 'p_dv', name: 'draws.view', description: 'View brackets and seeds.' },
    { id: 'p_dg', name: 'draws.generate', description: 'Run the SMT solver to build a draw.' },
    { id: 'p_de', name: 'draws.edit', description: 'Re-seed or manually swap matchups.' },
    { id: 'p_dp', name: 'draws.publish', description: 'Lock the draw and notify players.' },
    { id: 'p_dl', name: 'draws.lock', description: 'Freeze a draw against further edits.' },
    { id: 'p_cv', name: 'courts.view', description: 'See live court status.' },
    { id: 'p_ca', name: 'courts.assign', description: 'Send the next match to a court.' },
    { id: 'p_cs', name: 'courts.score', description: 'Tap in points during live play.' },
    { id: 'p_co', name: 'courts.override', description: 'Correct a posted score after the fact.' },
    { id: 'p_pv', name: 'players.view', description: 'Browse the player directory.' },
    { id: 'p_pc', name: 'players.create', description: 'Register a new player.' },
    { id: 'p_pe', name: 'players.edit', description: 'Update contact info, club, rating cap.' },
    { id: 'p_pd', name: 'players.delete', description: 'Soft-delete a player profile.' },
    { id: 'p_pm', name: 'players.merge', description: 'Combine two player records.' },
    { id: 'p_rv', name: 'ratings.view', description: 'See rating history and deltas.' },
    { id: 'p_rr', name: 'ratings.recalculate', description: 'Re-run the rating engine.' },
    { id: 'p_mv', name: 'members.view', description: 'See workspace members.' },
    { id: 'p_ma', name: 'members.add', description: 'Add a user to the workspace.' },
    { id: 'p_mr', name: 'members.remove', description: 'Remove a user from the workspace.' },
    { id: 'p_rm', name: 'roles.manage', description: 'Create, edit, and delete roles.' },
    { id: 'p_pa', name: 'permissions.assign', description: 'Attach permissions to roles.' },
    { id: 'p_sv', name: 'system.view', description: 'See system status.' },
    { id: 'p_sc', name: 'system.configure', description: 'Edit org-wide settings.' },
    { id: 'p_sx', name: 'system.export', description: 'Download backups and reports.' },
  ],
  roles: [
    // The default role (ADR-0016): every user holds it from the moment their
    // row is minted, it ships with zero permissions, and the API refuses to
    // rename or delete it. `is_default` is what the Roles page badges and
    // guards on.
    {
      id: 'r_user',
      name: 'User',
      description:
        'Held by every user. Carries no permissions by default — add one here to grant it to the whole population, including anonymous visitors.',
      permission_ids: [],
      is_default: true,
    },
    { id: 'r_owner', name: 'Owner', description: 'Full control of the workspace. Granted to founding admins.', permission_ids: ALL },
    {
      id: 'r_td',
      name: 'Tournament Director',
      description: 'Runs events end-to-end. Cannot edit org-wide settings.',
      permission_ids: [
        'p_tc', 'p_te', 'p_tp',
        'p_dv', 'p_dg', 'p_de', 'p_dp', 'p_dl',
        'p_cv', 'p_ca', 'p_cs', 'p_co',
        'p_pv', 'p_pc', 'p_pe', 'p_pm',
        'p_rv', 'p_rr',
        'p_mv', 'p_sx',
      ],
    },
    { id: 'r_score', name: 'Scorekeeper', description: 'Taps in points at courtside. Read-only everywhere else.', permission_ids: ['p_dv', 'p_cv', 'p_cs', 'p_pv'] },
    { id: 'r_umpire', name: 'Umpire', description: 'Calls matches. Can override scores after the fact.', permission_ids: ['p_dv', 'p_cv', 'p_cs', 'p_co', 'p_pv'] },
    { id: 'r_club', name: 'Club Admin', description: 'Manages the player roster. No live scoring.', permission_ids: ['p_dv', 'p_pv', 'p_pc', 'p_pe', 'p_pm', 'p_rv', 'p_mv'] },
    { id: 'r_read', name: 'Read-only', description: 'Sees everything, changes nothing.', permission_ids: VIEW },
    { id: 'r_weekend', name: 'Weekend Volunteer', description: 'One-off scorer role for weekend tournaments.', permission_ids: ['p_dv', 'p_cv', 'p_cs', 'p_pv'] },
  ],
  // Everyone holds `r_user` — that is what "default role" means (ADR-0016).
  users: [
    { id: 'u1', username: 'tim.nguyen', role_ids: ['r_user', 'r_owner'] },
    { id: 'u2', username: 'alex.johansen', role_ids: ['r_user', 'r_td'] },
    { id: 'u3', username: 'maya.okafor', role_ids: ['r_user', 'r_td', 'r_club'] },
    { id: 'u4', username: 'riley.park', role_ids: ['r_user', 'r_score'] },
    { id: 'u5', username: 'sam.patel', role_ids: ['r_user', 'r_score', 'r_umpire'] },
    { id: 'u6', username: 'lin.chen', role_ids: ['r_user', 'r_umpire'] },
    { id: 'u7', username: 'robin.kim', role_ids: ['r_user', 'r_club'] },
    { id: 'u8', username: 'dean.silva', role_ids: ['r_user', 'r_read'] },
    { id: 'u9', username: 'carlos.rossi', role_ids: ['r_user', 'r_read'] },
    { id: 'u10', username: 'jamie.tran', role_ids: ['r_user', 'r_weekend', 'r_umpire'] },
    { id: 'u11', username: 'priya.desai', role_ids: ['r_user', 'r_score'] },
    { id: 'u12', username: 'marcus.webb', role_ids: ['r_user', 'r_weekend'] },
    { id: 'u13', username: 'eun.han', role_ids: ['r_user'] },
  ],
}
