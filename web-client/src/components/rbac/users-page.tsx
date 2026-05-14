import { useMemo, useState, type CSSProperties } from 'react'
import { ChevronRight, Plus, Search, Trash2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { useSession } from '@/api/session'
import {
  type Permission,
  type RbacUser,
  type Role,
  useCreateRbacUser,
  useDeleteRbacUser,
  usePermissions,
  useRbacUsers,
  useRoles,
  useSetUserRoles,
} from './queries'
import { Avatar, EmptyState, Field, PageHeader, Stat, StatsGrid } from './primitives'
import { colorFor, fmtDate, fmtDateRel } from './helpers'

export function UsersPage() {
  const { data: users = [], isLoading: usersLoading } = useRbacUsers()
  const { data: roles = [] } = useRoles()
  const { data: permissions = [] } = usePermissions()
  const createUser = useCreateRbacUser()
  const deleteUser = useDeleteRbacUser()
  const setUserRoles = useSetUserRoles()
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<string>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<RbacUser | null>(null)

  const rolesById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles])
  const userCountByRole = useMemo(() => {
    const m = new Map<string, number>()
    for (const u of users) for (const rid of u.role_ids) m.set(rid, (m.get(rid) ?? 0) + 1)
    return m
  }, [users])
  const unassigned = useMemo(() => users.filter((u) => u.role_ids.length === 0).length, [users])
  const totalAssignments = useMemo(() => users.reduce((a, u) => a + u.role_ids.length, 0), [users])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return users.filter((u) => {
      if (search && !u.username.toLowerCase().includes(q)) return false
      if (roleFilter === 'unassigned') return u.role_ids.length === 0
      if (roleFilter !== 'all') return u.role_ids.includes(roleFilter)
      return true
    })
  }, [users, search, roleFilter])

  const selected = users.find((u) => u.id === selectedId) ?? null

  if (usersLoading) return <UsersPageSkeleton />

  if (users.length === 0) {
    return (
      <div style={{ padding: '40px 32px', maxWidth: 720, margin: '0 auto' }}>
        <EmptyState
          icon={Users}
          title="No users yet"
          body="Add a user to grant access to the workspace. After adding, click their row to attach roles."
          action={
            <Button onClick={() => setAdding(true)}>
              <Plus size={14} /> Add user
            </Button>
          }
        />
        {adding && (
          <AddUserModal
            existingUsernames={[]}
            onClose={() => setAdding(false)}
            onAdd={async (username) => {
              const created = await createUser.mutateAsync(username)
              setAdding(false)
              setSelectedId(created.id)
            }}
          />
        )}
      </div>
    )
  }

  return (
    <div style={{ padding: '24px 32px 40px', maxWidth: 1400, margin: '0 auto' }}>
      <PageHeader
        title="Users"
        subtitle="Every account in the workspace. Click a row to attach or detach roles."
        action={
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add user
          </Button>
        }
      />

      <StatsGrid>
        <Stat variant="card" label="Users" value={users.length} />
        <Stat variant="card" label="Role assignments" value={totalAssignments} />
        <Stat variant="card" label="Multi-role users" value={users.filter((u) => u.role_ids.length > 1).length} />
        <Stat variant="card" label="No role" value={unassigned} tone={unassigned > 0 ? 'warn' : 'live'} />
      </StatsGrid>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', width: 320 }}>
          <Search size={15} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--fg-3)' }} />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by username"
            style={{ paddingLeft: 32 }}
          />
        </div>
        <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} style={nativeSelectStyle}>
          <option value="all">All users ({users.length})</option>
          <option value="unassigned">No role ({unassigned})</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} ({userCountByRole.get(r.id) ?? 0})
            </option>
          ))}
        </select>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 12, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>
          showing <span style={{ color: 'var(--fg-1)', fontWeight: 600 }}>{filtered.length}</span> of{' '}
          <span style={{ color: 'var(--fg-1)', fontWeight: 600 }}>{users.length}</span>
        </div>
      </div>

      <div
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--r-md, 10px)',
          overflow: 'hidden',
        }}
      >
        <div style={tableHeaderStyle}>
          <div>User</div>
          <div>Roles</div>
          <div>Created</div>
          <div />
        </div>
        {filtered.map((u) => (
          <UserRow key={u.id} u={u} rolesById={rolesById} onClick={() => setSelectedId(u.id)} />
        ))}
        {filtered.length === 0 && (
          <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>
            No users match this filter.
          </div>
        )}
      </div>

      <UserDrawer
        user={selected}
        roles={roles}
        permissions={permissions}
        onSave={(next) => selected && setUserRoles.mutate({ id: selected.id, roleIds: next })}
        onRemove={() => selected && setConfirmRemove(selected)}
        onClose={() => setSelectedId(null)}
      />
      {adding && (
        <AddUserModal
          existingUsernames={users.map((u) => u.username)}
          onClose={() => setAdding(false)}
          onAdd={async (username) => {
            const created = await createUser.mutateAsync(username)
            setAdding(false)
            setSelectedId(created.id)
          }}
        />
      )}
      {confirmRemove && (
        <AlertDialog open onOpenChange={(o) => !o && setConfirmRemove(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {confirmRemove.username}?</AlertDialogTitle>
              <AlertDialogDescription>
                This deletes the user record. Their role assignments will be removed automatically. This can't be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  deleteUser.mutate(confirmRemove.id, {
                    onSuccess: () => setSelectedId(null),
                  })
                  setConfirmRemove(null)
                }}
              >
                Remove user
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
}

function UserRow({
  u,
  rolesById,
  onClick,
}: {
  u: RbacUser
  rolesById: Map<string, Role>
  onClick: () => void
}) {
  return (
    <div onClick={onClick} className="rbac-row" style={userRowStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <Avatar name={u.username} size={34} />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--fg-1)',
              fontFamily: 'var(--font-mono)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {u.username}
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2, fontFamily: 'var(--font-mono)' }}>
            {u.id}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {u.role_ids.length === 0 ? (
          <span style={{ fontSize: 11, color: 'var(--loss)', fontStyle: 'italic' }}>no role</span>
        ) : (
          u.role_ids.map((rid) => {
            const role = rolesById.get(rid)
            if (!role) return null
            return <RolePill key={rid} name={role.name} />
          })
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>
        {fmtDateRel(u.created_at)}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <ChevronRight size={16} color="var(--fg-muted)" strokeWidth={1.75} />
      </div>
    </div>
  )
}

export function RolePill({ name }: { name: string }) {
  const c = colorFor(name)
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 9px',
        borderRadius: 999,
        background: `${c}15`,
        border: `1px solid ${c}40`,
        fontSize: 11,
        color: c,
        fontWeight: 600,
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: c }} />
      {name}
    </span>
  )
}

function UserDrawer({
  user,
  roles,
  permissions,
  onSave,
  onRemove,
  onClose,
}: {
  user: RbacUser | null
  roles: Role[]
  permissions: Permission[]
  onSave: (role_ids: string[]) => void
  onRemove: () => void
  onClose: () => void
}) {
  return (
    <Sheet open={!!user} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="!w-[560px] !max-w-full !sm:max-w-full p-0">
        {user && (
          <UserDrawerBody
            key={user.id}
            user={user}
            roles={roles}
            permissions={permissions}
            onSave={onSave}
            onRemove={onRemove}
            onClose={onClose}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function UserDrawerBody({
  user,
  roles,
  permissions,
  onSave,
  onRemove,
  onClose,
}: {
  user: RbacUser
  roles: Role[]
  permissions: Permission[]
  onSave: (role_ids: string[]) => void
  onRemove: () => void
  onClose: () => void
}) {
  // Guard against removing your own account — that could lock the workspace
  // out (e.g. the last admin deleting themselves).
  const { data: session } = useSession()
  const isSelf = user.username === session?.data?.user?.username
  const [selected, setSelected] = useState<Set<string>>(() => new Set(user.role_ids))
  const dirty = useMemo(() => {
    if (selected.size !== user.role_ids.length) return true
    for (const rid of user.role_ids) if (!selected.has(rid)) return true
    return false
  }, [selected, user.role_ids])

  const rolesById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles])
  const { resolvedPermIds, resolvedPerms } = useMemo(() => {
    const ids = new Set<string>()
    for (const rid of selected) {
      const r = rolesById.get(rid)
      if (r) r.permission_ids.forEach((pid) => ids.add(pid))
    }
    return { resolvedPermIds: ids, resolvedPerms: permissions.filter((p) => ids.has(p.id)) }
  }, [selected, rolesById, permissions])

  function toggle(rid: string) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(rid)) next.delete(rid)
      else next.add(rid)
      return next
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-panel)' }}>
      <SheetHeader className="border-b border-[color:var(--border-subtle)] p-[22px_24px_18px] gap-0">
        <SheetTitle className="sr-only">User {user.username}</SheetTitle>
        <SheetDescription className="sr-only">
          Assign roles to {user.username} and review the permissions they grant.
        </SheetDescription>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <Avatar name={user.username} size={48} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: 'var(--fg-1)',
                margin: 0,
                fontFamily: 'var(--font-mono)',
              }}
            >
              {user.username}
            </h2>
            <div style={{ display: 'flex', gap: 18, marginTop: 10 }}>
              <Stat label="User ID" value={user.id} mono />
              <Stat label="Created" value={fmtDate(user.created_at)} />
              <Stat label="Roles" value={selected.size} />
            </div>
          </div>
        </div>
      </SheetHeader>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-1)', marginBottom: 2 }}>Assigned roles</div>
            <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>
              <span style={{ color: 'var(--fg-2)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                {selected.size}
              </span>{' '}
              of {roles.length} · grants{' '}
              <span style={{ color: 'var(--ball-400)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                {resolvedPermIds.size}
              </span>{' '}
              permissions
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          {roles.map((r) => (
            <RoleAssignRow key={r.id} role={r} on={selected.has(r.id)} onToggle={() => toggle(r.id)} />
          ))}
        </div>

        <div style={{ marginTop: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-1)', marginBottom: 6 }}>
            Effective permissions
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-3)', marginBottom: 10 }}>
            Union of every permission granted by the roles above.
          </div>
          {resolvedPerms.length === 0 ? (
            <div
              style={{
                padding: '18px',
                textAlign: 'center',
                fontSize: 12,
                color: 'var(--loss)',
                background: 'rgba(255,77,109,0.05)',
                border: '1px dashed rgba(255,77,109,0.3)',
                borderRadius: 'var(--r-md, 10px)',
              }}
            >
              {selected.size === 0
                ? "This user can't do anything. Attach at least one role."
                : `The attached role${selected.size === 1 ? ' grants' : 's grant'} no permissions yet — add permissions to ${selected.size === 1 ? 'it' : 'them'} to give this user access.`}
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {resolvedPerms.map((p) => (
                <code
                  key={p.id}
                  style={{
                    fontSize: 10.5,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--fg-2)',
                    background: 'var(--ink-900)',
                    padding: '2px 7px',
                    borderRadius: 4,
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  {p.name}
                </code>
              ))}
            </div>
          )}
        </div>
      </div>

      <SheetFooter
        className="border-t border-[color:var(--border-subtle)] bg-[color:var(--ink-900)]"
        style={{ flexDirection: 'row', justifyContent: 'space-between', padding: '16px 24px' }}
      >
        <Button
          variant="destructive"
          onClick={onRemove}
          disabled={isSelf}
          title={isSelf ? "You can't remove your own account." : undefined}
        >
          <Trash2 size={14} /> Remove user
        </Button>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!dirty} onClick={() => onSave([...selected])}>
            {dirty ? 'Save changes' : 'No changes'}
          </Button>
        </div>
      </SheetFooter>
    </div>
  )
}

function RoleAssignRow({ role, on, onToggle }: { role: Role; on: boolean; onToggle: () => void }) {
  const accent = colorFor(role.name)
  return (
    <div
      onClick={onToggle}
      className="rbac-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 14px',
        cursor: 'pointer',
        background: on ? `${accent}10` : 'var(--bg-card)',
        border: `1px solid ${on ? accent + '55' : 'var(--border-subtle)'}`,
        borderRadius: 'var(--r-md, 10px)',
        transition: 'all 120ms cubic-bezier(0.2, 0.8, 0.2, 1)',
      }}
    >
      <Checkbox
        checked={on}
        onCheckedChange={onToggle}
        onClick={(e) => e.stopPropagation()}
      />
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: accent,
          flexShrink: 0,
          boxShadow: on ? `0 0 8px ${accent}88` : 'none',
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: on ? 'var(--fg-1)' : 'var(--fg-2)' }}>{role.name}</div>
        <div
          style={{
            fontSize: 11,
            color: role.description ? 'var(--fg-3)' : 'var(--fg-muted)',
            fontStyle: role.description ? 'normal' : 'italic',
            lineHeight: 1.4,
            marginTop: 2,
          }}
        >
          {role.description || 'No description'}
        </div>
      </div>
      <div
        style={{
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          color: 'var(--fg-3)',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}
      >
        {role.permission_ids.length} perms
      </div>
    </div>
  )
}

function AddUserModal({
  existingUsernames,
  onClose,
  onAdd,
}: {
  existingUsernames: string[]
  onClose: () => void
  onAdd: (username: string) => void
}) {
  const [username, setUsername] = useState('')
  const trimmed = username.trim()
  const taken = existingUsernames.some((u) => u.toLowerCase() === trimmed.toLowerCase())
  const validShape = /^[a-z0-9._-]{2,}$/i.test(trimmed)
  const valid = trimmed && validShape && !taken
  const { hint, hintTone } = validateUsername({ trimmed, taken, validShape })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>
            Create a workspace account, then attach roles from its drawer.
          </DialogDescription>
        </DialogHeader>
        <Field label="Username" hint={hint} hintTone={hintTone}>
          <Input
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="e.g. jamie.tran"
            style={{ fontFamily: 'var(--font-mono)' }}
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!valid} onClick={() => onAdd(trimmed)}>Add user</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function validateUsername({
  trimmed,
  taken,
  validShape,
}: {
  trimmed: string
  taken: boolean
  validShape: boolean
}): { hint: string; hintTone: 'neutral' | 'loss' } {
  if (taken) return { hint: 'That username is already taken.', hintTone: 'loss' }
  if (trimmed && !validShape) {
    return { hint: 'Letters, numbers, dots, dashes, underscores. Min 2 characters.', hintTone: 'loss' }
  }
  return { hint: 'Must be unique. After creating, click the row to attach roles.', hintTone: 'neutral' }
}

function UsersPageSkeleton() {
  return (
    <div style={{ padding: '24px 32px 40px', maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <Skeleton className="h-7 w-32 mb-2" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 18 }}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    </div>
  )
}

const tableHeaderStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1.4fr 130px 40px',
  padding: '10px 20px',
  borderBottom: '1px solid var(--border-subtle)',
  background: 'var(--ink-800)',
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.14em',
  color: 'var(--fg-muted)',
  textTransform: 'uppercase',
}

const userRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1.4fr 130px 40px',
  padding: '14px 20px',
  alignItems: 'center',
  gap: 12,
  borderTop: '1px solid var(--border-subtle)',
  cursor: 'pointer',
}

const nativeSelectStyle: CSSProperties = {
  height: 34,
  padding: '0 12px',
  background: 'var(--bg-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--r-md, 10px)',
  color: 'var(--fg-2)',
  fontSize: 13,
  fontFamily: 'var(--font-ui)',
  outline: 'none',
  cursor: 'pointer',
}
