export type Permission = {
  id: string
  name: string
  description: string | null
  created_at: string
  updated_at: string
}

export type Role = {
  id: string
  name: string
  description: string | null
  created_at: string
  updated_at: string
  permission_ids: string[]
}

export type User = {
  id: string
  username: string
  role_ids: string[]
  created_at: string
}

export const PERMISSIONS_SEED: Permission[] = (
  [
    { id: 'p_tv', name: 'tournament.view', description: 'See tournament list and details.' },
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
  ] as const
).map((p) => ({
  ...p,
  created_at: '2026-01-04T09:00:00Z',
  updated_at: '2026-01-04T09:00:00Z',
}))

const ALL_PERM_IDS = PERMISSIONS_SEED.map((p) => p.id)

export const ROLES_SEED: Role[] = [
  {
    id: 'r_owner',
    name: 'Owner',
    description: 'Full control of the workspace. Granted to founding admins.',
    created_at: '2026-01-04T09:00:00Z',
    updated_at: '2026-01-04T09:00:00Z',
    permission_ids: ALL_PERM_IDS,
  },
  {
    id: 'r_td',
    name: 'Tournament Director',
    description: 'Runs events end-to-end. Cannot edit org-wide settings.',
    created_at: '2026-01-12T15:22:11Z',
    updated_at: '2026-04-22T18:04:00Z',
    permission_ids: [
      'p_tv', 'p_tc', 'p_te', 'p_tp',
      'p_dv', 'p_dg', 'p_de', 'p_dp', 'p_dl',
      'p_cv', 'p_ca', 'p_cs', 'p_co',
      'p_pv', 'p_pc', 'p_pe', 'p_pm',
      'p_rv', 'p_rr',
      'p_mv', 'p_sx',
    ],
  },
  {
    id: 'r_score',
    name: 'Scorekeeper',
    description: 'Taps in points at courtside. Read-only everywhere else.',
    created_at: '2026-01-12T15:24:01Z',
    updated_at: '2026-04-18T12:30:00Z',
    permission_ids: ['p_tv', 'p_dv', 'p_cv', 'p_cs', 'p_pv'],
  },
  {
    id: 'r_umpire',
    name: 'Umpire',
    description: 'Calls matches. Can override scores after the fact.',
    created_at: '2026-01-20T08:11:43Z',
    updated_at: '2026-03-30T09:15:00Z',
    permission_ids: ['p_tv', 'p_dv', 'p_cv', 'p_cs', 'p_co', 'p_pv'],
  },
  {
    id: 'r_club',
    name: 'Club Admin',
    description: 'Manages the player roster. No live scoring.',
    created_at: '2026-02-02T11:08:12Z',
    updated_at: '2026-02-11T14:18:00Z',
    permission_ids: ['p_tv', 'p_dv', 'p_pv', 'p_pc', 'p_pe', 'p_pm', 'p_rv', 'p_mv'],
  },
  {
    id: 'r_read',
    name: 'Read-only',
    description: 'Sees everything, changes nothing.',
    created_at: '2026-01-04T09:00:00Z',
    updated_at: '2026-01-04T09:00:00Z',
    permission_ids: PERMISSIONS_SEED.filter((p) => p.name.endsWith('.view')).map((p) => p.id),
  },
  {
    id: 'r_weekend',
    name: 'Weekend Volunteer',
    description: 'One-off scorer role for weekend tournaments.',
    created_at: '2026-05-01T10:02:18Z',
    updated_at: '2026-05-09T16:42:00Z',
    permission_ids: ['p_tv', 'p_dv', 'p_cv', 'p_cs', 'p_pv'],
  },
]

export const USERS_SEED: User[] = [
  { id: 'u1', username: 'tim.nguyen', role_ids: ['r_owner'], created_at: '2026-01-04T09:00:00Z' },
  { id: 'u2', username: 'alex.johansen', role_ids: ['r_td'], created_at: '2026-01-12T16:00:00Z' },
  { id: 'u3', username: 'maya.okafor', role_ids: ['r_td', 'r_club'], created_at: '2026-01-12T16:08:00Z' },
  { id: 'u4', username: 'riley.park', role_ids: ['r_score'], created_at: '2026-02-04T09:11:00Z' },
  { id: 'u5', username: 'sam.patel', role_ids: ['r_score', 'r_umpire'], created_at: '2026-02-04T09:12:00Z' },
  { id: 'u6', username: 'lin.chen', role_ids: ['r_umpire'], created_at: '2026-02-19T11:42:00Z' },
  { id: 'u7', username: 'robin.kim', role_ids: ['r_club'], created_at: '2026-02-21T08:30:00Z' },
  { id: 'u8', username: 'dean.silva', role_ids: ['r_read'], created_at: '2026-03-02T15:00:00Z' },
  { id: 'u9', username: 'carlos.rossi', role_ids: ['r_read'], created_at: '2026-03-04T17:21:00Z' },
  { id: 'u10', username: 'jamie.tran', role_ids: ['r_weekend', 'r_umpire'], created_at: '2026-05-01T10:05:00Z' },
  { id: 'u11', username: 'priya.desai', role_ids: ['r_score'], created_at: '2026-03-18T14:48:00Z' },
  { id: 'u12', username: 'marcus.webb', role_ids: ['r_weekend'], created_at: '2026-05-08T12:00:00Z' },
  { id: 'u13', username: 'eun.han', role_ids: [], created_at: '2026-05-10T09:14:00Z' },
]
