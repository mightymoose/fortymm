import { useMemo, useState, type CSSProperties } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { ChevronDown, Folder, Info, Key, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { ApiError } from '@/api/client'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
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
import { foldForSearch } from '@/lib/fold-text'
import { Skeleton } from '@/components/ui/skeleton'
import {
  type Permission,
  type Role,
  useCreatePermission,
  useDeletePermission,
  usePermissions,
  useRoles,
  useUpdatePermission,
} from './queries'
import { EmptyState, PageHeader, Stat, StatsGrid } from './primitives'
import { PermissionCode, PrefixLabel } from './roles-page'
import { colorFor, fmtDate, fmtDateRel, groupPermissions, permPrefix } from './helpers'

// Intentionally stricter than the server's PERMISSION_NAME_PATTERN
// (api/app/schemas/rbac.py): the documented convention is `resource.action`,
// so the client enforces exactly one dot rather than "one or more".
const PERMISSION_NAME_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/

function buildPermissionSchema(existingNames: string[]) {
  const taken = new Set(existingNames.map((n) => n.toLowerCase()))
  return z.object({
    name: z
      .string()
      .trim()
      .min(1, { message: 'Name is required.' })
      .max(255, { message: 'Name must be 255 characters or fewer.' })
      .refine((v) => PERMISSION_NAME_RE.test(v), {
        message:
          'Use lowercase letters, numbers, and underscores in a resource.action shape — exactly one dot (e.g. tournament.publish).',
      })
      .refine((v) => !taken.has(v.toLowerCase()), {
        message: 'A permission with this name already exists.',
      }),
    description: z
      .string()
      .trim()
      .max(1024, { message: 'Description must be 1024 characters or fewer.' })
      .optional(),
  })
}

type PermissionFormValues = z.infer<ReturnType<typeof buildPermissionSchema>>

export function PermissionsPage() {
  const { data: permissions = [], isLoading: permsLoading } = usePermissions()
  const { data: roles = [] } = useRoles()
  const createPermission = useCreatePermission()
  const updatePermission = useUpdatePermission()
  const deletePermission = useDeletePermission()
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Permission | null>(null)
  const [confirmDel, setConfirmDel] = useState<Permission | null>(null)

  const ownersByPerm = useMemo(() => {
    const m = new Map<string, Role[]>()
    for (const r of roles) for (const pid of r.permission_ids) {
      const list = m.get(pid)
      if (list) list.push(r)
      else m.set(pid, [r])
    }
    return m
  }, [roles])

  const allGroups = useMemo(() => groupPermissions(permissions), [permissions])
  const allGroupPrefixes = useMemo(() => allGroups.map((g) => g.prefix), [allGroups])

  const grouped = useMemo(() => {
    if (!search) return allGroups
    const q = foldForSearch(search)
    return groupPermissions(
      permissions.filter(
        (p) => foldForSearch(p.name).includes(q) || foldForSearch(p.description || '').includes(q),
      ),
    )
  }, [allGroups, permissions, search])

  const grandTotal = permissions.length
  const assigned = useMemo(
    () => permissions.filter((p) => (ownersByPerm.get(p.id) ?? []).length > 0).length,
    [permissions, ownersByPerm],
  )

  function toggleGroup(prefix: string) {
    setCollapsed((s) => {
      const next = new Set(s)
      if (next.has(prefix)) next.delete(prefix)
      else next.add(prefix)
      return next
    })
  }

  if (permsLoading) return <PermissionsPageSkeleton />

  if (permissions.length === 0) {
    return (
      <div style={{ padding: '24px 32px 40px', maxWidth: 1280, margin: '0 auto' }}>
        <PageHeader
          title="Permissions"
          subtitle={
            <>
              Every action a role can grant. Names follow <code style={inlineCode}>resource.action</code>.
            </>
          }
        />
        <div style={{ marginTop: 24 }}>
          <EmptyState
            icon={Key}
            title="No permissions yet"
            body="Permissions are the leaf-level actions roles bundle together (e.g. tournament.publish). Create the first one to start defining what your roles can do."
            action={
              <Button onClick={() => setCreating(true)}>
                <Plus size={14} /> New permission
              </Button>
            }
          />
        </div>
        {creating && (
          <PermissionFormModal
            title="New permission"
            submitLabel="Create permission"
            verb="create"
            existingNames={[]}
            onClose={() => setCreating(false)}
            onSubmit={async (data) => {
              await createPermission.mutateAsync(data)
              setCreating(false)
            }}
          />
        )}
      </div>
    )
  }

  return (
    <div style={{ padding: '24px 32px 40px', maxWidth: 1280, margin: '0 auto' }}>
      <PageHeader
        title="Permissions"
        subtitle={
          <>
            Every action a role can grant. Names follow <code style={inlineCode}>resource.action</code> — we
            group by the prefix so the list stays scannable.
          </>
        }
        action={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={14} /> New permission
          </Button>
        }
      />

      <StatsGrid>
        <Stat variant="card" label="Permissions" value={grandTotal} />
        <Stat variant="card" label="Name prefixes" value={allGroupPrefixes.length} />
        <Stat variant="card" label="In use" value={`${assigned} / ${grandTotal}`} tone="live" />
        <Stat
          variant="card"
          label="Unassigned"
          value={grandTotal - assigned}
          tone={grandTotal - assigned > 0 ? 'warn' : 'live'}
        />
      </StatsGrid>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div style={{ position: 'relative', width: 320 }}>
          <Search size={15} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--fg-3)' }} />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or description"
            style={{ paddingLeft: 32 }}
          />
        </div>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={() => setCollapsed(new Set())} style={linkBtn}>
          Expand all
        </button>
        <span style={{ color: 'var(--fg-muted)' }}>·</span>
        <button type="button" onClick={() => setCollapsed(new Set(allGroupPrefixes))} style={linkBtn}>
          Collapse all
        </button>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        {grouped.map(({ prefix, items }) => {
          const open = !collapsed.has(prefix)
          return (
            <div key={prefix} style={groupCardStyle}>
              <div onClick={() => toggleGroup(prefix)} style={groupHeaderStyle(open)}>
                <Folder size={16} color="var(--ball-400)" strokeWidth={1.75} />
                <PrefixLabel prefix={prefix} />
                <div style={{ flex: 1 }} />
                <span style={countTextStyle}>
                  {items.length} {items.length === 1 ? 'permission' : 'permissions'}
                </span>
                <div style={{ transform: open ? 'rotate(0)' : 'rotate(-90deg)', transition: 'transform 160ms', display: 'flex' }}>
                  <ChevronDown size={16} color="var(--fg-3)" strokeWidth={1.75} />
                </div>
              </div>
              {open && (
                <div>
                  <div style={tableHeaderStyle}>
                    <div>Name</div>
                    <div>Description</div>
                    <div>Used by</div>
                    <div style={{ textAlign: 'right' }}>Actions</div>
                  </div>
                  {items.map((p) => (
                    <PermissionListRow
                      key={p.id}
                      p={p}
                      owners={ownersByPerm.get(p.id) ?? []}
                      onEdit={() => setEditing(p)}
                      onDelete={() => setConfirmDel(p)}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {grouped.length === 0 && (
          <div
            style={{
              padding: '48px 20px',
              textAlign: 'center',
              color: 'var(--fg-3)',
              fontSize: 13,
              background: 'var(--bg-card)',
              border: '1px dashed var(--border-subtle)',
              borderRadius: 'var(--r-md, 10px)',
            }}
          >
            No permissions match.
          </div>
        )}
      </div>

      <div style={infoBoxStyle}>
        <Info size={18} color="var(--info)" strokeWidth={1.75} />
        <div style={{ fontSize: 12, color: 'var(--fg-3)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--fg-1)', fontWeight: 600 }}>Permissions are flat.</strong> The grouping
          above is just visual — we split on the dot in the name. Granting{' '}
          <code style={inlineCode}>tournament.edit</code> does not imply{' '}
          <code style={inlineCode}>draws.edit</code>. Use roles to bundle permissions together.
        </div>
      </div>

      {creating && (
        <PermissionFormModal
          title="New permission"
          submitLabel="Create permission"
          verb="create"
          existingNames={permissions.map((p) => p.name)}
          onClose={() => setCreating(false)}
          onSubmit={async (data) => {
            await createPermission.mutateAsync(data)
            setCreating(false)
            setCollapsed((c) => {
              const next = new Set(c)
              next.delete(permPrefix(data.name))
              return next
            })
          }}
        />
      )}
      {editing && (
        <PermissionFormModal
          title="Edit permission"
          submitLabel="Save changes"
          verb="update"
          existingNames={permissions.filter((p) => p.id !== editing.id).map((p) => p.name)}
          initial={editing}
          onClose={() => setEditing(null)}
          onSubmit={async (data) => {
            await updatePermission.mutateAsync({ id: editing.id, patch: data })
            setEditing(null)
          }}
        />
      )}
      {confirmDel && (
        <DeletePermissionDialog
          permission={confirmDel}
          ownerCount={(ownersByPerm.get(confirmDel.id) ?? []).length}
          onCancel={() => setConfirmDel(null)}
          onConfirm={() => {
            deletePermission.mutate(confirmDel.id)
            setConfirmDel(null)
          }}
        />
      )}
    </div>
  )
}

function PermissionListRow({
  p,
  owners,
  onEdit,
  onDelete,
}: {
  p: Permission
  owners: Role[]
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div className="rbac-row" style={listRowStyle} data-testid={`perm-row-${p.name}`}>
      <PermissionCode name={p.name} active />
      <div
        style={{
          fontSize: 13,
          color: p.description ? 'var(--fg-2)' : 'var(--fg-muted)',
          fontStyle: p.description ? 'normal' : 'italic',
          lineHeight: 1.5,
        }}
      >
        {p.description || 'No description'}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {owners.length === 0 ? (
          <span style={{ fontSize: 11, color: 'var(--fg-muted)', fontStyle: 'italic' }}>unassigned</span>
        ) : (
          owners.slice(0, 3).map((r) => <OwnerPill key={r.id} name={r.name} />)
        )}
        {owners.length > 3 && (
          <span style={{ fontSize: 11, color: 'var(--fg-3)', alignSelf: 'center' }}>+{owners.length - 3}</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onEdit} title="Edit" style={iconBtnStyle}>
          <Pencil size={14} color="var(--fg-2)" strokeWidth={1.75} />
        </button>
        <button type="button" onClick={onDelete} title="Delete" style={iconBtnStyle}>
          <Trash2 size={14} color="var(--loss)" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  )
}

function OwnerPill({ name }: { name: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 8px',
        borderRadius: 999,
        background: 'var(--ink-700)',
        border: '1px solid var(--border-subtle)',
        fontSize: 11,
        color: 'var(--fg-2)',
        fontWeight: 500,
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: colorFor(name) }} />
      {name}
    </span>
  )
}

function PermissionFormModal({
  title,
  submitLabel,
  verb,
  existingNames,
  initial,
  onClose,
  onSubmit,
}: {
  title: string
  submitLabel: string
  verb: 'create' | 'update'
  existingNames: string[]
  initial?: Permission
  onClose: () => void
  onSubmit: (data: { name: string; description: string }) => Promise<void>
}) {
  const schema = useMemo(() => buildPermissionSchema(existingNames), [existingNames])
  const form = useForm<PermissionFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initial?.name ?? '',
      description: initial?.description ?? '',
    },
    mode: 'onChange',
  })

  const handleSubmit = form.handleSubmit(async (values) => {
    try {
      await onSubmit({ name: values.name, description: values.description ?? '' })
    } catch (err) {
      // 4xx errors that target a field land inline; everything else (5xx,
      // network) goes to the toast so the user still sees what failed.
      if (err instanceof ApiError && (err.status === 409 || err.status === 422)) {
        form.setError('name', {
          type: 'server',
          message: err.detail ?? 'Server rejected this name.',
        })
        return
      }
      toast.error(`Couldn't ${verb} the permission`, {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {verb === 'create'
              ? 'Add a leaf-level action that roles can grant.'
              : 'Rename this permission or update its description.'}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={handleSubmit} noValidate>
            <div style={{ display: 'grid', gap: 16 }}>
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input
                        autoFocus
                        placeholder="tournament.publish"
                        style={{ fontFamily: 'var(--font-mono)' }}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Convention: resource.action (e.g. courts.score)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="e.g. Publish a tournament to the spectator view."
                        style={{ minHeight: 80 }}
                        {...field}
                        value={field.value ?? ''}
                      />
                    </FormControl>
                    <FormDescription>
                      What does this permission let someone do?
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {initial && (
                <div
                  style={{
                    display: 'flex',
                    gap: 24,
                    padding: '12px 14px',
                    background: 'var(--ink-900)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--r-md, 10px)',
                  }}
                >
                  <Stat label="Created" value={fmtDate(initial.created_at)} />
                  <Stat label="Updated" value={fmtDateRel(initial.updated_at)} />
                  <Stat label="ID" value={initial.id} mono />
                </div>
              )}
            </div>
            <DialogFooter style={{ marginTop: 16 }}>
              <Button variant="outline" type="button" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit">{submitLabel}</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

function DeletePermissionDialog({
  permission,
  ownerCount,
  onCancel,
  onConfirm,
}: {
  permission: Permission
  ownerCount: number
  onCancel: () => void
  onConfirm: () => void
}) {
  const body =
    ownerCount === 0
      ? 'No roles currently include this permission. It will be removed permanently.'
      : `${ownerCount} role${ownerCount === 1 ? '' : 's'} currently include this permission. They will lose it. This can't be undone.`
  return (
    <AlertDialog open onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {permission.name}?</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Delete permission</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

const groupCardStyle: CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-md, 10px)',
  overflow: 'hidden',
}

function groupHeaderStyle(open: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '14px 18px',
    cursor: 'pointer',
    userSelect: 'none',
    background: 'var(--ink-800)',
    borderBottom: open ? '1px solid var(--border-subtle)' : 'none',
  }
}

const countTextStyle: CSSProperties = {
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  color: 'var(--fg-3)',
  fontVariantNumeric: 'tabular-nums',
}

const tableHeaderStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(220px, 0.9fr) 1.4fr 200px 80px',
  padding: '8px 18px',
  borderBottom: '1px solid var(--border-subtle)',
  background: 'var(--ink-900)',
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.14em',
  color: 'var(--fg-muted)',
  textTransform: 'uppercase',
}

const listRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(220px, 0.9fr) 1.4fr 200px 80px',
  padding: '12px 18px',
  alignItems: 'center',
  gap: 12,
  borderTop: '1px solid var(--border-subtle)',
}

const infoBoxStyle: CSSProperties = {
  marginTop: 24,
  padding: 16,
  background: 'var(--bg-card)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-md, 10px)',
  display: 'flex',
  gap: 14,
  alignItems: 'flex-start',
}

const linkBtn: CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--fg-3)',
  fontSize: 12,
  fontFamily: 'var(--font-ui)',
  fontWeight: 500,
  padding: '4px 6px',
  textDecoration: 'underline',
  textUnderlineOffset: 3,
}
const inlineCode: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ball-400)',
  background: 'var(--ink-900)',
  padding: '1px 5px',
  borderRadius: 3,
  border: '1px solid var(--border-subtle)',
}
function PermissionsPageSkeleton() {
  return (
    <div style={{ padding: '24px 32px 40px', maxWidth: 1280, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <Skeleton className="h-7 w-48 mb-2" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 18 }}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    </div>
  )
}

const iconBtnStyle: CSSProperties = {
  width: 28,
  height: 28,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: '1px solid var(--border-subtle)',
  borderRadius: 6,
  cursor: 'pointer',
  padding: 0,
}
