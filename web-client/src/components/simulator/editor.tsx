/* =====================================================================
   editor.tsx — Configuration editor screen
   ===================================================================== */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  CalendarRange,
  Dice5,
  ListChecks,
  Loader2,
  Play,
  Plus,
  Sparkles,
  Table2,
  Trash2,
  Trophy,
  Users,
} from 'lucide-react'
import {
  eventColor,
  minutesBetween,
  nid,
  totalExpectedMatches,
  type Config,
  type Player,
  type Schedule,
  type SolveError,
  type TablePool,
  type Table as TableT,
  type ValidationError,
  type ValidationScope,
} from './data'

// ---------- Reusable bits ----------
function Field({
  label,
  children,
  error,
  help,
  span = 4,
}: {
  label: string
  children: ReactNode
  error?: string | null
  help?: string
  span?: number
}) {
  return (
    <div className="field" style={{ gridColumn: `span ${span}` }}>
      <label>{label}</label>
      {children}
      {error && <div className="errmsg">{error}</div>}
      {help && !error && <div className="help">{help}</div>}
    </div>
  )
}

function TextInput({
  value,
  onChange,
  invalid,
  ...rest
}: {
  value: string
  onChange: (v: string) => void
  invalid?: boolean
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <input
      type="text"
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      className={invalid ? 'invalid' : ''}
      {...rest}
    />
  )
}

function NumInput({
  value,
  onChange,
  invalid,
  step = 1,
  ...rest
}: {
  value: number | null
  onChange: (v: number | null) => void
  invalid?: boolean
  step?: number
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'step'>) {
  return (
    <input
      type="number"
      className={`mono ${invalid ? 'invalid' : ''}`}
      value={value ?? ''}
      step={step}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      {...rest}
    />
  )
}

function TimeInput({
  valueISO,
  onChange,
  invalid,
}: {
  valueISO: string
  onChange: (iso: string) => void
  invalid?: boolean
}) {
  const v = useMemo(() => {
    if (!valueISO) return ''
    const d = new Date(valueISO)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }, [valueISO])
  return (
    <input
      type="time"
      className={`mono ${invalid ? 'invalid' : ''}`}
      value={v}
      onChange={(e) => {
        const [h, m] = e.target.value.split(':').map(Number)
        const d = new Date(valueISO)
        d.setHours(h, m, 0, 0)
        onChange(d.toISOString())
      }}
    />
  )
}

// ---------- Player chip selector ----------
function PlayerRoster({
  allPlayers,
  selectedIds,
  onChange,
}: {
  allPlayers: Player[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const selectedSet = new Set(selectedIds)
  const available = allPlayers.filter((p) => !selectedSet.has(p.id))
  const selected = selectedIds
    .map((id) => allPlayers.find((p) => p.id === id))
    .filter((p): p is Player => Boolean(p))

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <div className="chipset">
        {selected.map((p) => (
          <span className="chip" key={p.id}>
            {p.name}
            {p.rating != null && <span className="rating">{p.rating}</span>}
            <button onClick={() => onChange(selectedIds.filter((id) => id !== p.id))} title="Remove">
              ×
            </button>
          </span>
        ))}
        <button className="add-chip" onClick={() => setOpen((o) => !o)}>
          + Add player {selected.length > 0 ? `(${selected.length})` : ''}
        </button>
      </div>
      {open && available.length > 0 && (
        <div
          style={{
            position: 'absolute',
            zIndex: 10,
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 4,
            maxHeight: 240,
            overflow: 'auto',
            background: 'var(--ink-900)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--r-sm)',
            boxShadow: 'var(--shadow-md)',
            padding: 4,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '4px 8px',
              color: 'var(--fg-3)',
              fontSize: 11,
            }}
          >
            <span>{available.length} available</span>
            <button
              className="btn ghost sm"
              onClick={() => onChange([...selectedIds, ...available.map((a) => a.id)])}
            >
              Add all
            </button>
          </div>
          {available.map((p) => (
            <div
              key={p.id}
              onClick={() => onChange([...selectedIds, p.id])}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '5px 8px',
                cursor: 'pointer',
                borderRadius: 4,
                fontSize: 12,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <span>{p.name}</span>
              <span style={{ color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>
                {p.rating ?? '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------- Table pool editor ----------
function PoolEditor({
  pool,
  tables,
  onChange,
  onRemove,
  dayEndMin,
  invalidEnd,
  invalidTables,
}: {
  pool: TablePool
  tables: TableT[]
  onChange: (p: TablePool) => void
  onRemove: () => void
  dayEndMin: number
  invalidEnd?: boolean
  invalidTables?: boolean
}) {
  const tSet = new Set(pool.tableIds)
  return (
    <div
      style={{
        border: '1px solid var(--border-subtle)',
        background: 'var(--ink-900)',
        borderRadius: 'var(--r-sm)',
        padding: 12,
        marginBottom: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div className="overline" style={{ fontSize: 10 }}>
          Pool window
        </div>
        <div style={{ flex: 1 }}></div>
        <button className="btn ghost sm" onClick={onRemove}>
          Remove pool
        </button>
      </div>
      <div className="fields">
        <Field label="Start (min from start)" span={3}>
          <NumInput
            value={pool.startMin}
            onChange={(v) => onChange({ ...pool, startMin: v ?? 0 })}
            min={0}
            step={5}
            max={dayEndMin}
          />
        </Field>
        <Field
          label="End (min from start)"
          span={3}
          error={invalidEnd ? 'Must be after start' : null}
        >
          <NumInput
            value={pool.endMin}
            onChange={(v) => onChange({ ...pool, endMin: v ?? 0 })}
            min={0}
            step={5}
            max={dayEndMin}
            invalid={invalidEnd}
          />
        </Field>
        <Field
          label={`Tables (${pool.tableIds.length})`}
          span={6}
          error={invalidTables ? 'Need at least 1 table' : null}
        >
          <div className="chipset" style={{ minHeight: 32 }}>
            {tables.map((t) => {
              const active = tSet.has(t.id)
              return (
                <button
                  key={t.id}
                  onClick={() =>
                    onChange({
                      ...pool,
                      tableIds: active
                        ? pool.tableIds.filter((id) => id !== t.id)
                        : [...pool.tableIds, t.id],
                    })
                  }
                  className="chip"
                  style={{
                    cursor: 'pointer',
                    background: active ? 'var(--ball-500)' : 'var(--ink-800)',
                    color: active ? 'var(--fg-inverse)' : 'var(--fg-2)',
                    border: 0,
                    padding: '3px 10px',
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {t.name}
                </button>
              )
            })}
          </div>
        </Field>
      </div>
    </div>
  )
}

// ---------- Random player generator ----------
const RAND_FIRST = ['Alex','Sam','Jordan','Casey','Riley','Morgan','Quinn','Avery','Cameron','Drew','Skyler','Reese','Hayden','Eden','Sage','Robin','Finley','River','Phoenix','Logan','Devon','Kai','Rowan','Ari','Nova','Wren','Sasha','Ezra','Indi','Marin']
const RAND_LAST = ['Nguyen','Chen','Patel','Rivera','Park','Brooks','Tanaka','Shah','Weber','Cole','Murray','Sato','Ng','Petrov','Hill','Mori','Garcia','Kumar','Reyes','Walsh','Hoffman','Bauer','Sasaki','Klein','Mendez','Holt','Bell','Singh','Ayers']

function randomPlayer(): Player {
  const f = RAND_FIRST[Math.floor(Math.random() * RAND_FIRST.length)]
  const l = RAND_LAST[Math.floor(Math.random() * RAND_LAST.length)]
  const r = 1100 + Math.floor(Math.random() * 1300)
  return { id: nid('plr'), name: `${f} ${l}`, rating: r }
}

// ---------- Editor main ----------
export function Editor({
  config,
  setConfig,
  errors,
  onSolve,
  onViewSchedule,
  onLoadExample,
  onReset,
  solving,
  schedule,
  infeasibleErr,
}: {
  config: Config
  setConfig: (c: Config) => void
  errors: ValidationError[]
  onSolve: () => void
  onViewSchedule: () => void
  onLoadExample: () => void
  onReset: () => void
  solving: boolean
  schedule: Schedule | null
  infeasibleErr: SolveError | null
}) {
  const [activeSection, setActiveSection] = useState<ValidationScope>('tournament')
  const scrollRef = useRef<HTMLDivElement>(null)
  const errorsByScope = useMemo(() => {
    const out: Record<string, ValidationError[]> = {
      tournament: [],
      tables: [],
      players: [],
      events: [],
      pools: [],
    }
    errors.forEach((e) => {
      ;(out[e.scope] || (out[e.scope] = [])).push(e)
    })
    return out
  }, [errors])
  const fieldErr = (scope: ValidationScope, ref: string | undefined, field: string) =>
    errors.find((e) => e.scope === scope && e.ref === ref && e.field === field)?.msg

  const scrollTo = (id: ValidationScope) => {
    setActiveSection(id)
    const el = scrollRef.current?.querySelector<HTMLElement>(`#sec-${id}`)
    if (el && scrollRef.current) {
      scrollRef.current.scrollTo({ top: el.offsetTop - 12, behavior: 'smooth' })
    }
  }

  // Update helpers
  const upd = (patch: Partial<Config>) => setConfig({ ...config, ...patch })
  const updTable = (id: string, patch: Partial<TableT>) =>
    upd({ tables: config.tables.map((t) => (t.id === id ? { ...t, ...patch } : t)) })
  const updPlayer = (id: string, patch: Partial<Player>) =>
    upd({ players: config.players.map((p) => (p.id === id ? { ...p, ...patch } : p)) })
  const updEvent = (id: string, patch: Partial<Config['events'][number]>) =>
    upd({ events: config.events.map((e) => (e.id === id ? { ...e, ...patch } : e)) })
  const updPool = (id: string, patch: Partial<TablePool>) =>
    upd({ tablePools: config.tablePools.map((p) => (p.id === id ? { ...p, ...patch } : p)) })

  const dayEndMin =
    config.startISO && config.endISO ? minutesBetween(config.startISO, config.endISO) : 600

  const expectedMatches = totalExpectedMatches(config)

  const sideItems: [ValidationScope, string, ReactNode][] = [
    ['tournament', 'Tournament', <Trophy size={14} key="i" />],
    ['tables', 'Tables', <Table2 size={14} key="i" />],
    ['players', 'Players', <Users size={14} key="i" />],
    ['events', 'Events', <ListChecks size={14} key="i" />],
    ['pools', 'Table pools', <CalendarRange size={14} key="i" />],
  ]

  return (
    <div className="editor">
      <aside className="side">
        <h4>Configuration</h4>
        {sideItems.map(([key, label, icon]) => {
          const errN = errorsByScope[key]?.length || 0
          let count: number | null = null
          if (key === 'tables') count = config.tables.length
          else if (key === 'players') count = config.players.length
          else if (key === 'events') count = config.events.length
          else if (key === 'pools') count = config.tablePools.length
          return (
            <a
              key={key}
              className={activeSection === key ? 'active' : ''}
              onClick={() => scrollTo(key)}
            >
              {icon}
              <span>{label}</span>
              {errN > 0 ? (
                <span className="err">{errN}</span>
              ) : (
                count != null && <span className="count">{count}</span>
              )}
            </a>
          )
        })}
        <div className="actions">
          <button className="btn" onClick={onLoadExample}>
            <Sparkles size={14} />
            Load example
          </button>
          <button className="btn ghost" onClick={onReset}>
            Reset
          </button>
        </div>
      </aside>

      <div className="scroll" ref={scrollRef}>
        {/* Summary banners */}
        {infeasibleErr && (
          <div className="banner error">
            <AlertOctagon size={18} style={{ color: 'var(--loss)' }} />
            <div className="grow">
              <strong>Infeasible.</strong> {infeasibleErr.msg}
            </div>
          </div>
        )}
        {errors.length > 0 && (
          <div className="banner warn">
            <AlertTriangle size={18} style={{ color: 'var(--warn)' }} />
            <div className="grow">
              <strong>
                {errors.length} {errors.length === 1 ? 'issue' : 'issues'} to fix before solving.
              </strong>
              <ul>
                {errors.slice(0, 5).map((e, i) => (
                  <li key={i}>
                    <a onClick={() => scrollTo(e.scope)}>{e.scope}</a>
                    {' — '}
                    {e.msg}
                  </li>
                ))}
                {errors.length > 5 && <li>…and {errors.length - 5} more</li>}
              </ul>
            </div>
          </div>
        )}

        {/* ---- TOURNAMENT ---- */}
        <section id="sec-tournament" className="card">
          <header>
            <h2>Tournament</h2>
            <div className="hint">Name, date, window.</div>
            <div className="grow"></div>
          </header>
          <div className="fields">
            <Field label="Name" span={5} error={fieldErr('tournament', undefined, 'name')}>
              <TextInput
                value={config.name}
                onChange={(v) => upd({ name: v })}
                invalid={!!fieldErr('tournament', undefined, 'name')}
                placeholder="e.g. Spring Open 2026"
              />
            </Field>
            <Field label="Date" span={3}>
              <input
                type="date"
                className="mono"
                value={config.startISO?.slice(0, 10) || ''}
                onChange={(e) => {
                  const date = e.target.value
                  if (!date) return
                  const s = new Date(config.startISO)
                  const en = new Date(config.endISO)
                  const [y, M, d] = date.split('-').map(Number)
                  s.setFullYear(y, M - 1, d)
                  en.setFullYear(y, M - 1, d)
                  upd({ startISO: s.toISOString(), endISO: en.toISOString() })
                }}
              />
            </Field>
            <Field label="Start" span={2}>
              <TimeInput valueISO={config.startISO} onChange={(iso) => upd({ startISO: iso })} />
            </Field>
            <Field label="End" span={2} error={fieldErr('tournament', undefined, 'endISO')}>
              <TimeInput
                valueISO={config.endISO}
                onChange={(iso) => upd({ endISO: iso })}
                invalid={!!fieldErr('tournament', undefined, 'endISO')}
              />
            </Field>
          </div>
        </section>

        {/* ---- TABLES ---- */}
        <section id="sec-tables" className="card">
          <header>
            <h2>Tables</h2>
            <div className="hint">
              {config.tables.length} table{config.tables.length === 1 ? '' : 's'}.
            </div>
            <div className="grow"></div>
            <button
              className="btn sm"
              onClick={() =>
                upd({
                  tables: [
                    ...config.tables,
                    { id: nid('tbl'), name: `Table ${config.tables.length + 1}` },
                  ],
                })
              }
            >
              <Plus size={12} /> Add table
            </button>
          </header>
          {config.tables.length === 0 ? (
            <div className="empty">No tables yet. Add one above.</div>
          ) : (
            <table className="list">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th>Name</th>
                  <th className="actions">&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {config.tables.map((t, i) => (
                  <tr key={t.id}>
                    <td className="mono">{i + 1}</td>
                    <td>
                      <input
                        type="text"
                        value={t.name || ''}
                        onChange={(e) => updTable(t.id, { name: e.target.value })}
                        className={fieldErr('tables', t.id, 'name') ? 'invalid' : ''}
                      />
                    </td>
                    <td className="actions">
                      <button
                        className="btn ghost sm"
                        onClick={() => upd({ tables: config.tables.filter((x) => x.id !== t.id) })}
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* ---- PLAYERS ---- */}
        <section id="sec-players" className="card">
          <header>
            <h2>Players</h2>
            <div className="hint">
              {config.players.length} player{config.players.length === 1 ? '' : 's'} · drop into events below.
            </div>
            <div className="grow"></div>
            <button
              className="btn sm"
              onClick={() =>
                upd({ players: [...config.players, { id: nid('plr'), name: '', rating: null }] })
              }
            >
              <Plus size={12} /> Add player
            </button>
            <button
              className="btn sm"
              onClick={() => {
                const adds = Array.from({ length: 8 }, () => randomPlayer())
                upd({ players: [...config.players, ...adds] })
              }}
            >
              <Dice5 size={12} /> + 8 random
            </button>
          </header>
          {config.players.length === 0 ? (
            <div className="empty">No players. Add some manually, or use “+ 8 random”.</div>
          ) : (
            <table className="list">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th>Name</th>
                  <th style={{ width: 120 }}>USATT rating</th>
                  <th>Events</th>
                  <th className="actions">&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {config.players.map((p, i) => {
                  const inEvents = config.events.filter((e) => e.playerIds.includes(p.id))
                  return (
                    <tr key={p.id}>
                      <td className="mono">{String(i + 1).padStart(2, '0')}</td>
                      <td>
                        <input
                          type="text"
                          value={p.name || ''}
                          onChange={(e) => updPlayer(p.id, { name: e.target.value })}
                          className={fieldErr('players', p.id, 'name') ? 'invalid' : ''}
                          placeholder="Player name"
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          className={'mono ' + (fieldErr('players', p.id, 'rating') ? 'invalid' : '')}
                          value={p.rating ?? ''}
                          onChange={(e) =>
                            updPlayer(p.id, {
                              rating: e.target.value === '' ? null : parseInt(e.target.value, 10),
                            })
                          }
                          placeholder="—"
                          min={0}
                          max={3000}
                        />
                      </td>
                      <td>
                        <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                          {inEvents.length === 0 ? '—' : inEvents.map((e) => e.name).join(', ')}
                        </span>
                      </td>
                      <td className="actions">
                        <button
                          className="btn ghost sm"
                          onClick={() => {
                            upd({
                              players: config.players.filter((x) => x.id !== p.id),
                              events: config.events.map((ev) => ({
                                ...ev,
                                playerIds: ev.playerIds.filter((id) => id !== p.id),
                              })),
                            })
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>

        {/* ---- EVENTS ---- */}
        <section id="sec-events" className="card">
          <header>
            <h2>Events</h2>
            <div className="hint">
              {config.events.length} event{config.events.length === 1 ? '' : 's'} ·{' '}
              <span className="mono" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-2)' }}>
                {expectedMatches}
              </span>{' '}
              matches total
            </div>
            <div className="grow"></div>
            <button
              className="btn sm"
              onClick={() =>
                upd({
                  events: [
                    ...config.events,
                    {
                      id: nid('ev'),
                      name: `Event ${config.events.length + 1}`,
                      matchDurationMin: 25,
                      restMin: 15,
                      format: 'round_robin',
                      playerIds: [],
                    },
                  ],
                })
              }
            >
              <Plus size={12} /> Add event
            </button>
          </header>
          {config.events.length === 0 ? (
            <div className="empty">No events yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {config.events.map((ev, idx) => {
                const matchCount = (ev.playerIds.length * (ev.playerIds.length - 1)) / 2
                const color = eventColor(idx)
                return (
                  <div
                    key={ev.id}
                    style={{
                      background: 'var(--ink-900)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--r-sm)',
                      padding: 14,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                      <span
                        style={{
                          display: 'inline-block',
                          width: 10,
                          height: 10,
                          borderRadius: 2,
                          background: color,
                        }}
                      ></span>
                      <input
                        type="text"
                        value={ev.name}
                        onChange={(e) => updEvent(ev.id, { name: e.target.value })}
                        className={fieldErr('events', ev.id, 'name') ? 'invalid' : ''}
                        style={{ fontSize: 14, fontWeight: 600, padding: '4px 8px', minWidth: 200 }}
                      />
                      <div style={{ flex: 1 }}></div>
                      <span style={{ fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>
                        {matchCount} matches
                      </span>
                      <button
                        className="btn ghost sm"
                        onClick={() =>
                          upd({
                            events: config.events.filter((e2) => e2.id !== ev.id),
                            tablePools: config.tablePools.filter((p) => p.eventId !== ev.id),
                          })
                        }
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    <div className="fields">
                      <Field label="Format" span={3}>
                        <select
                          value={ev.format}
                          onChange={(e) =>
                            updEvent(ev.id, { format: e.target.value as Config['events'][number]['format'] })
                          }
                        >
                          <option value="round_robin">Round robin</option>
                        </select>
                      </Field>
                      <Field
                        label="Match duration (min)"
                        span={3}
                        error={fieldErr('events', ev.id, 'matchDurationMin')}
                        help="Multiples of 5"
                      >
                        <NumInput
                          value={ev.matchDurationMin}
                          onChange={(v) => updEvent(ev.id, { matchDurationMin: v ?? 0 })}
                          step={5}
                          min={5}
                          max={120}
                          invalid={!!fieldErr('events', ev.id, 'matchDurationMin')}
                        />
                      </Field>
                      <Field label="Min rest (min)" span={3} error={fieldErr('events', ev.id, 'restMin')}>
                        <NumInput
                          value={ev.restMin}
                          onChange={(v) => updEvent(ev.id, { restMin: v ?? 0 })}
                          step={5}
                          min={0}
                          max={120}
                          invalid={!!fieldErr('events', ev.id, 'restMin')}
                        />
                      </Field>
                      <Field label="Players" span={3}>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            fontFamily: 'var(--font-mono)',
                            fontSize: 13,
                            height: 30,
                          }}
                        >
                          <span style={{ color: 'var(--fg-1)', fontWeight: 600 }}>
                            {ev.playerIds.length}
                          </span>
                          <span style={{ color: 'var(--fg-3)' }}>·</span>
                          <span style={{ color: 'var(--fg-3)' }}>{matchCount} matches</span>
                        </div>
                      </Field>
                      <Field label="Roster" span={12} error={fieldErr('events', ev.id, 'playerIds')}>
                        <PlayerRoster
                          allPlayers={config.players}
                          selectedIds={ev.playerIds}
                          onChange={(ids) => updEvent(ev.id, { playerIds: ids })}
                        />
                      </Field>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* ---- TABLE POOLS ---- */}
        <section id="sec-pools" className="card">
          <header>
            <h2>Table pools</h2>
            <div className="hint">
              Each pool ties tables to an event for a time window. An event can have multiple pools.
            </div>
            <div className="grow"></div>
          </header>
          {config.events.length === 0 ? (
            <div className="empty">Add an event first.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {config.events.map((ev, idx) => {
                const evPools = config.tablePools.filter((p) => p.eventId === ev.id)
                const color = eventColor(idx)
                const noPoolErr = fieldErr('events', ev.id, 'pools')
                return (
                  <div key={ev.id}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: color }}></span>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{ev.name}</span>
                      <span style={{ color: 'var(--fg-3)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                        {evPools.length} pool{evPools.length === 1 ? '' : 's'}
                      </span>
                      <div style={{ flex: 1 }}></div>
                      <button
                        className="btn sm"
                        onClick={() =>
                          upd({
                            tablePools: [
                              ...config.tablePools,
                              {
                                id: nid('pool'),
                                eventId: ev.id,
                                tableIds: config.tables
                                  .slice(0, Math.min(3, config.tables.length))
                                  .map((t) => t.id),
                                startMin: 0,
                                endMin: Math.min(240, dayEndMin),
                              },
                            ],
                          })
                        }
                      >
                        <Plus size={12} /> Add pool
                      </button>
                    </div>
                    {noPoolErr && (
                      <div
                        style={{
                          color: 'var(--loss)',
                          fontSize: 12,
                          fontFamily: 'var(--font-mono)',
                          marginBottom: 8,
                        }}
                      >
                        {noPoolErr}
                      </div>
                    )}
                    {evPools.length === 0 ? (
                      <div className="empty" style={{ padding: 12 }}>
                        No pools yet.
                      </div>
                    ) : (
                      evPools.map((pool) => (
                        <PoolEditor
                          key={pool.id}
                          pool={pool}
                          tables={config.tables}
                          dayEndMin={dayEndMin}
                          onChange={(p) => updPool(pool.id, p)}
                          onRemove={() =>
                            upd({ tablePools: config.tablePools.filter((p) => p.id !== pool.id) })
                          }
                          invalidEnd={!!fieldErr('pools', pool.id, 'endMin')}
                          invalidTables={!!fieldErr('pools', pool.id, 'tableIds')}
                        />
                      ))
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>

      <div className="footer">
        <div className="summary">
          {config.events.length} events · <span className="mono">{config.players.length}</span> players ·{' '}
          <span className="mono">{config.tables.length}</span> tables ·{' '}
          <span className="mono">{expectedMatches}</span> matches to schedule
        </div>
        <div className="grow"></div>
        {schedule && !solving && (
          <button className="btn ghost" onClick={onViewSchedule}>
            View current schedule <ArrowRight size={12} />
          </button>
        )}
        <button className="btn primary" disabled={errors.length > 0 || solving} onClick={onSolve}>
          {solving ? (
            <>
              <Loader2 size={14} className="spin" /> Solving…
            </>
          ) : (
            <>
              <Play size={14} /> Solve
            </>
          )}
        </button>
      </div>
    </div>
  )
}
