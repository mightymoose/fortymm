import { useMemo, useState, type CSSProperties } from 'react'
import { Check, Copy, Folder, Plus, Search, Shield, Trash2, Users, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { Skeleton } from '@/components/ui/skeleton'
import {
  type Permission,
  type RbacUser,
  type Role,
  useCreateRole,
  useDeleteRole,
  usePermissions,
  useRbacUsers,
  useRoles,
  useSetUserRoles,
  useUpdateRole,
} from './queries'
import { Avatar, EmptyState, Field, Stat } from './primitives'
import { colorFor, fmtDate, fmtDateRel, groupPermissions } from './helpers'

export function RolesPage() {
  const { data: roles = [], isLoading: rolesLoading } = useRoles()
  const { data: permissions = [] } = usePermissions()
  const { data: users = [] } = useRbacUsers()
  const createRole = useCreateRole()
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const memberCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const u of users) for (const rid of u.role_ids) m.set(rid, (m.get(rid) ?? 0) + 1)
    return m
  }, [users])

  const totalAssignments = useMemo(() => users.reduce((a, u) => a + u.role_ids.length, 0), [users])

  const filtered = useMemo(() => {
    if (!search) return roles
    const q = search.toLowerCase()
    return roles.filter((r) => r.name.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q))
  }, [roles, search])

  // Track selection against the *filtered* list: a role the search has hidden
  // must not linger in the detail panel. Falls back to the first visible role.
  const selected = filtered.find((r) => r.id === selectedId) ?? filtered[0] ?? null

  if (rolesLoading) return <RolesPageSkeleton />

  if (roles.length === 0) {
    return (
      <div style={{ padding: '40px 32px', maxWidth: 720, margin: '0 auto' }}>
        <EmptyState
          icon={Shield}
          title="No roles yet"
          body="Roles bundle permissions together so you can hand out access in one click. Create your first role to start assigning it to users."
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus size={14} /> New role
            </Button>
          }
        />
        {creating && (
          <NewRoleModal
            existing={[]}
            onClose={() => setCreating(false)}
            onCreate={async (input) => {
              const created = await createRole.mutateAsync({
                name: input.name,
                description: input.description,
                template_id: input.templateId,
              })
              setSelectedId(created.id)
              setCreating(false)
            }}
          />
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <div
        style={{
          width: 380,
          borderRight: '1px solid var(--border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-panel)',
        }}
      >
        <div style={{ padding: '18px 18px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--fg-1)' }}>Roles</div>
              <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 2 }}>
                <span style={{ fontFamily: 'var(--font-mono)' }}>{roles.length}</span> roles ·{' '}
                <span style={{ fontFamily: 'var(--font-mono)' }}>{totalAssignments}</span> assignments
              </div>
            </div>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus size={14} /> New role
            </Button>
          </div>
          <div style={{ position: 'relative' }}>
            <Search size={15} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--fg-3)' }} />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search roles"
              style={{ paddingLeft: 32 }}
            />
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {filtered.map((r) => (
            <RoleRow
              key={r.id}
              role={r}
              memberCount={memberCounts.get(r.id) ?? 0}
              active={r.id === selected?.id}
              onClick={() => setSelectedId(r.id)}
            />
          ))}
          {filtered.length === 0 && (
            <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--fg-3)', fontSize: 13 }}>
              No roles match.
            </div>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-app)' }}>
        {selected ? (
          <RoleDetail role={selected} permissions={permissions} users={users} onSelect={setSelectedId} />
        ) : (
          <div style={{ padding: 40, color: 'var(--fg-3)' }}>
            No role selected.{' '}
            <a onClick={() => setCreating(true)} style={{ color: 'var(--ball-400)', cursor: 'pointer' }}>
              Create one.
            </a>
          </div>
        )}
      </div>

      {creating && (
        <NewRoleModal
          existing={roles}
          onClose={() => setCreating(false)}
          onCreate={async (input) => {
            const created = await createRole.mutateAsync({
              name: input.name,
              description: input.description,
              template_id: input.templateId,
            })
            setSelectedId(created.id)
            setCreating(false)
          }}
        />
      )}
    </div>
  )
}

function RoleRow({
  role,
  memberCount,
  active,
  onClick,
}: {
  role: Role
  memberCount: number
  active: boolean
  onClick: () => void
}) {
  const accent = colorFor(role.name)
  return (
    <div
      onClick={onClick}
      className="rbac-row"
      data-active={active || undefined}
      style={{
        padding: '14px 18px 14px 15px',
        cursor: 'pointer',
        borderLeft: `3px solid ${active ? 'var(--ball-500)' : 'transparent'}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: accent,
            flexShrink: 0,
            boxShadow: `0 0 8px ${accent}55`,
          }}
        />
        <div style={{ flex: 1, fontSize: 14, fontWeight: 600, color: 'var(--fg-1)' }}>{role.name}</div>
      </div>
      <div
        style={{
          fontSize: 12,
          color: 'var(--fg-3)',
          marginBottom: 8,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          lineHeight: 1.4,
          minHeight: role.description ? undefined : 18,
        }}
      >
        {role.description || (
          <span style={{ fontStyle: 'italic', color: 'var(--fg-muted)' }}>No description</span>
        )}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 14,
          fontSize: 11,
          color: 'var(--fg-muted)',
          fontFamily: 'var(--font-mono)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <span>
          <span style={{ color: 'var(--fg-2)', fontWeight: 600 }}>{memberCount}</span> users
        </span>
        <span>
          <span style={{ color: 'var(--fg-2)', fontWeight: 600 }}>{role.permission_ids.length}</span> perms
        </span>
        <span style={{ marginLeft: 'auto' }}>{fmtDateRel(role.updated_at)}</span>
      </div>
    </div>
  )
}

function RoleDetail({
  role,
  permissions,
  users,
  onSelect,
}: {
  role: Role
  permissions: Permission[]
  users: RbacUser[]
  onSelect: (id: string | null) => void
}) {
  const updateRole = useUpdateRole()
  const deleteRole = useDeleteRole()
  const createRole = useCreateRole()
  const setUserRoles = useSetUserRoles()
  const [tab, setTab] = useState<'permissions' | 'members'>('permissions')
  const [editingName, setEditingName] = useState(false)
  const [editingDesc, setEditingDesc] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const accent = colorFor(role.name)
  const members = useMemo(() => users.filter((u) => u.role_ids.includes(role.id)), [users, role.id])
  const permSet = useMemo(() => new Set(role.permission_ids), [role.permission_ids])

  function togglePerm(id: string) {
    const next = permSet.has(id)
      ? role.permission_ids.filter((p) => p !== id)
      : [...role.permission_ids, id]
    updateRole.mutate({ id: role.id, patch: { permission_ids: next } })
  }
  function toggleGroup(ids: string[], allOn: boolean) {
    const next = allOn
      ? role.permission_ids.filter((p) => !ids.includes(p))
      : [...new Set([...role.permission_ids, ...ids])]
    updateRole.mutate({ id: role.id, patch: { permission_ids: next } })
  }
  function revokeFromUser(userId: string) {
    const user = users.find((u) => u.id === userId)
    if (!user) return
    setUserRoles.mutate({
      id: userId,
      roleIds: user.role_ids.filter((rid) => rid !== role.id),
    })
  }

  return (
    <div>
      <div style={{ padding: '24px 32px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <div
            style={{
              width: 42,
              height: 42,
              borderRadius: 'var(--r-md, 10px)',
              background: `${accent}22`,
              border: `1px solid ${accent}55`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Shield size={20} color={accent} strokeWidth={1.75} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {editingName ? (
              <Input
                autoFocus
                defaultValue={role.name}
                onBlur={(e) => {
                  updateRole.mutate({ id: role.id, patch: { name: e.target.value.trim() || role.name } })
                  setEditingName(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') {
                    ;(e.target as HTMLInputElement).value = role.name
                    ;(e.target as HTMLInputElement).blur()
                  }
                }}
                style={{ fontSize: 22, fontWeight: 700, height: 38, maxWidth: 420 }}
              />
            ) : (
              <h1 onClick={() => setEditingName(true)} className="rbac-inline-edit" style={titleStyle}>
                {role.name}
              </h1>
            )}
            {editingDesc ? (
              <Textarea
                autoFocus
                defaultValue={role.description || ''}
                onBlur={(e) => {
                  updateRole.mutate({ id: role.id, patch: { description: e.target.value.trim() } })
                  setEditingDesc(false)
                }}
                placeholder="Describe what this role can do…"
                style={{ maxWidth: 640, minHeight: 50, fontSize: 13 }}
              />
            ) : (
              <div onClick={() => setEditingDesc(true)} className="rbac-inline-edit" style={descStyle(!!role.description)}>
                {role.description || 'No description — click to add one'}
              </div>
            )}
            <div style={{ display: 'flex', gap: 24, marginTop: 14, flexWrap: 'wrap' }}>
              <Stat label="Users" value={members.length} />
              <Stat label="Permissions" value={`${role.permission_ids.length} / ${permissions.length}`} />
              <Stat label="Created" value={fmtDate(role.created_at)} />
              <Stat label="Updated" value={fmtDateRel(role.updated_at)} />
              <Stat label="ID" value={role.id} mono />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const dup = await createRole.mutateAsync({
                  name: `${role.name} (copy)`,
                  description: role.description,
                  template_id: role.id,
                })
                onSelect(dup.id)
              }}
            >
              <Copy size={14} /> Duplicate
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={14} /> Delete
            </Button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 2, marginTop: 20, marginBottom: -20 }}>
          {TABS.map(({ key, label }) => {
            const count = key === 'permissions' ? role.permission_ids.length : members.length
            return (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                style={tabStyle(tab === key)}
              >
                {label}
                <span style={tabCountStyle}>{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div style={{ padding: '24px 32px 40px' }}>
        {tab === 'permissions' && (
          <PermissionsEditor
            permissions={permissions}
            permSet={permSet}
            onToggle={togglePerm}
            onToggleGroup={toggleGroup}
          />
        )}
        {tab === 'members' && (
          <RoleMembers
            role={role}
            members={members}
            onRevoke={revokeFromUser}
          />
        )}
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {role.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {members.length} user{members.length === 1 ? '' : 's'} will lose this role. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                deleteRole.mutate(role.id, { onSuccess: () => onSelect(null) })
              }
            >
              Delete role
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

const TABS = [
  { key: 'permissions' as const, label: 'Permissions' },
  { key: 'members' as const, label: 'Users' },
]

function PermissionsEditor({
  permissions,
  permSet,
  onToggle,
  onToggleGroup,
}: {
  permissions: Permission[]
  permSet: Set<string>
  onToggle: (id: string) => void
  onToggleGroup: (ids: string[], allOn: boolean) => void
}) {
  const grouped = useMemo(() => groupPermissions(permissions), [permissions])
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: 'var(--fg-3)' }}>
          Tick the permissions this role grants. Changes save instantly.
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            onToggleGroup(
              permissions.map((p) => p.id),
              permSet.size === permissions.length,
            )
          }
        >
          {permSet.size === permissions.length ? 'Clear all' : 'Select all'}
        </Button>
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        {grouped.map(({ prefix, items }) => {
          const ids = items.map((p) => p.id)
          const ownedInGroup = ids.filter((k) => permSet.has(k))
          const allOn = ownedInGroup.length === ids.length
          const someOn = ownedInGroup.length > 0 && !allOn
          return (
            <div
              key={prefix}
              style={{
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--r-md, 10px)',
                background: 'var(--bg-card)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '12px 16px',
                  background: 'var(--ink-800)',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                <Folder size={15} color="var(--fg-3)" strokeWidth={1.75} />
                <PrefixLabel prefix={prefix} />
                <div style={{ flex: 1 }} />
                <span
                  style={{
                    fontSize: 11,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--fg-3)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {ownedInGroup.length} / {ids.length}
                </span>
                <Checkbox
                  checked={allOn ? true : someOn ? 'indeterminate' : false}
                  onCheckedChange={() => onToggleGroup(ids, allOn)}
                />
              </div>
              <div>
                {items.map((p) => (
                  <PermRow key={p.id} p={p} on={permSet.has(p.id)} onToggle={() => onToggle(p.id)} />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PermRow({ p, on, onToggle }: { p: Permission; on: boolean; onToggle: () => void }) {
  return (
    <div
      onClick={onToggle}
      className="rbac-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '12px 16px',
        cursor: 'pointer',
        borderTop: '1px solid var(--border-subtle)',
      }}
    >
      <Checkbox
        checked={on}
        onCheckedChange={onToggle}
        onClick={(e) => e.stopPropagation()}
      />
      <PermissionCode name={p.name} active={on} />
      <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--fg-3)', lineHeight: 1.4 }}>
        {p.description || (
          <span style={{ fontStyle: 'italic', color: 'var(--fg-muted)' }}>No description</span>
        )}
      </div>
    </div>
  )
}

export function PermissionCode({ name, active }: { name: string; active?: boolean }) {
  return (
    <code
      style={{
        fontSize: 12.5,
        fontFamily: 'var(--font-mono)',
        color: active ? 'var(--fg-1)' : 'var(--fg-2)',
        background: 'var(--ink-900)',
        padding: '3px 9px',
        borderRadius: 4,
        border: '1px solid var(--border-subtle)',
        flexShrink: 0,
        justifySelf: 'start',
        fontWeight: 600,
      }}
    >
      {name}
    </code>
  )
}

export function PrefixLabel({ prefix }: { prefix: string }) {
  return (
    <code
      style={{
        fontSize: 13,
        fontWeight: 600,
        fontFamily: 'var(--font-mono)',
        color: 'var(--fg-1)',
        background: 'transparent',
        border: 'none',
        padding: 0,
      }}
    >
      {prefix}.*
    </code>
  )
}

function RoleMembers({
  role,
  members,
  onRevoke,
}: {
  role: Role
  members: RbacUser[]
  onRevoke: (uid: string) => void
}) {
  if (members.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No users have this role yet"
        body={`Go to Users to assign ${role.name} to someone.`}
      />
    )
  }
  return (
    <div>
      <div style={{ fontSize: 13, color: 'var(--fg-3)', marginBottom: 14 }}>
        <span style={{ color: 'var(--fg-1)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
          {members.length}
        </span>{' '}
        user{members.length === 1 ? '' : 's'} {members.length === 1 ? 'has' : 'have'} this role.
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {members.map((m) => (
          <div
            key={m.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '12px 16px',
              background: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--r-md, 10px)',
            }}
          >
            <Avatar name={m.username} size={32} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-1)', fontFamily: 'var(--font-mono)' }}>
                {m.username}
              </div>
              <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2 }}>
                user id <span style={{ fontFamily: 'var(--font-mono)' }}>{m.id}</span>
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>
              added {fmtDateRel(m.created_at)}
            </div>
            <Button size="sm" variant="ghost" onClick={() => onRevoke(m.id)}>
              <X size={14} /> Revoke
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

function NewRoleModal({
  existing,
  onClose,
  onCreate,
}: {
  existing: Role[]
  onClose: () => void
  onCreate: (input: { name: string; description: string; templateId?: string }) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const trimmed = name.trim()
  const taken = existing.some((r) => r.name.toLowerCase() === trimmed.toLowerCase())
  // A missing name surfaces only once the user tries to submit; a duplicate
  // name is flagged live. Mirrors the Permissions dialog's inline feedback so
  // an empty submit is never a silent no-op.
  const nameError = !trimmed
    ? submitAttempted
      ? 'Name is required.'
      : null
    : taken
      ? 'A role with this name already exists.'
      : null

  function handleCreate() {
    setSubmitAttempted(true)
    if (!trimmed || taken) return
    onCreate({ name: trimmed, description: description.trim(), templateId: templateId || undefined })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New role</DialogTitle>
          <DialogDescription>
            Name the role and optionally copy permissions from an existing one.
          </DialogDescription>
        </DialogHeader>
        <div style={{ display: 'grid', gap: 16 }}>
          <Field label="Name" hint={nameError} hintTone={nameError ? 'loss' : 'neutral'}>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Volunteer scorer" />
          </Field>
          <Field label="Description" hint="Optional. Helps the next admin understand what this role does.">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What can people with this role do?"
              style={{ minHeight: 70 }}
            />
          </Field>
          <Field label="Copy permissions from" hint="Optional. Lets you start from an existing role.">
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} style={nativeSelectStyle}>
              <option value="">Blank — no permissions</option>
              {existing.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.permission_ids.length} perms)
                </option>
              ))}
            </select>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleCreate}>
            <Check size={14} /> Create role
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RolesPageSkeleton() {
  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <div
        style={{
          width: 380,
          borderRight: '1px solid var(--border-subtle)',
          background: 'var(--bg-panel)',
          padding: 18,
          display: 'grid',
          gap: 12,
        }}
      >
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-9 w-full" />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
      <div style={{ flex: 1, padding: 32, display: 'grid', gap: 16, alignContent: 'start' }}>
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-4 w-96" />
        <div style={{ display: 'flex', gap: 18, marginTop: 8 }}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-24" />
          ))}
        </div>
        <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      </div>
    </div>
  )
}

const titleStyle: CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  color: 'var(--fg-1)',
  margin: '0 0 4px',
  cursor: 'text',
  display: 'inline-block',
  padding: '2px 6px',
  marginLeft: -6,
  borderRadius: 6,
}

function descStyle(hasDescription: boolean): CSSProperties {
  return {
    fontSize: 13,
    color: hasDescription ? 'var(--fg-3)' : 'var(--fg-muted)',
    fontStyle: hasDescription ? 'normal' : 'italic',
    maxWidth: 640,
    cursor: 'text',
    padding: '4px 6px',
    marginLeft: -6,
    borderRadius: 6,
    lineHeight: 1.5,
  }
}

function tabStyle(active: boolean): CSSProperties {
  return {
    padding: '10px 14px',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: 'var(--font-ui)',
    color: active ? 'var(--ball-400)' : 'var(--fg-3)',
    borderBottom: active ? '2px solid var(--ball-500)' : '2px solid transparent',
    marginBottom: -1,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
  }
}

const tabCountStyle: CSSProperties = {
  padding: '1px 7px',
  borderRadius: 999,
  fontSize: 10,
  fontFamily: 'var(--font-mono)',
  fontVariantNumeric: 'tabular-nums',
  background: 'var(--ink-700)',
  color: 'var(--fg-3)',
}

const nativeSelectStyle: CSSProperties = {
  width: '100%',
  height: 38,
  padding: '0 12px',
  background: 'var(--bg-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--r-md, 10px)',
  color: 'var(--fg-1)',
  fontFamily: 'var(--font-ui)',
  fontSize: 13,
  outline: 'none',
  cursor: 'pointer',
}
