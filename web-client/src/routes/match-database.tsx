import { createFileRoute, Link } from '@tanstack/react-router'
import type { Core } from 'fortymm-core/fortymm-core.mjs'
import { type FormEvent, useRef, useState } from 'react'
import { type ApplyAnswer, applyParcels } from '../api/match-database.ts'
import { loadCore } from '../core/load.ts'
import {
  createSigner,
  fromHex,
  makeMatchParcel,
  playerIds,
  type Signer,
} from '../core/match-parcel.ts'

// /match-database: a temporary screen to simulate intake by hand. Make signed
// match parcels in the browser (or paste parcels), send them with a database
// to the api's temporary apply endpoint, and see the new database. Nothing is
// stored, here or on the server: the database, the parcels and the signing
// key live in this page, and a reload starts again from {} with a new key.
export const Route = createFileRoute('/match-database')({
  component: MatchDatabasePage,
})

const environments = [
  { number: 3, name: 'Development' },
  { number: 2, name: 'UAT' },
  { number: 1, name: 'Production' },
]

function MatchDatabasePage() {
  const [databaseText, setDatabaseText] = useState('{}')
  const [parcels, setParcels] = useState<string[]>([])
  const [sideOne, setSideOne] = useState('11'.repeat(32))
  const [sideTwo, setSideTwo] = useState('22'.repeat(32))
  const [terms, setTerms] = useState('')
  const [environment, setEnvironment] = useState('3')
  const [makeError, setMakeError] = useState<string | null>(null)
  const [answer, setAnswer] = useState<ApplyAnswer | null>(null)
  const [busy, setBusy] = useState(false)
  // One key for the life of the page, made on first use.
  const signing = useRef<Promise<{ core: Core; signer: Signer }> | null>(null)

  async function makeParcel() {
    const sides = [playerIds(sideOne), playerIds(sideTwo)] as const
    const termBytes = fromHex(terms)
    if (sides[0] === null || sides[1] === null) {
      setMakeError('Each side needs one or more player ids, 64 hex digits each, one per line.')
      return
    }
    if (termBytes === null) {
      setMakeError('The terms must be hex: pairs of 0-9 and a-f.')
      return
    }
    setMakeError(null)
    try {
      signing.current ??= loadCore().then(async (core) => ({
        core,
        signer: await createSigner(core),
      }))
      const { core, signer } = await signing.current
      const text = await makeMatchParcel(core, signer, {
        environment: Number(environment),
        sides: [sides[0], sides[1]],
        terms: termBytes,
      })
      setParcels((current) => [...current, text])
    } catch (error) {
      // For example no WebCrypto (the page is not https or localhost), or
      // the core's WebAssembly file did not load. Try again from scratch.
      signing.current = null
      setMakeError(`The parcel could not be made: ${String(error)}`)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setAnswer(await applyParcels({ databaseText, parcels, arrivedAt: new Date() }))
    setBusy(false)
  }

  return (
    <section>
      <h1>Match database</h1>
      <p>
        A simulation of intake: nothing is stored. Make or paste parcels, then
        apply them to the database.
      </p>

      <fieldset>
        <legend>Make a match parcel</legend>
        <label>
          Side one players
          <textarea value={sideOne} onChange={(e) => setSideOne(e.target.value)} />
        </label>
        <label>
          Side two players
          <textarea value={sideTwo} onChange={(e) => setSideTwo(e.target.value)} />
        </label>
        <label>
          Terms
          <input value={terms} onChange={(e) => setTerms(e.target.value)} />
        </label>
        <label>
          Environment
          <select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
            {environments.map(({ number, name }) => (
              <option key={number} value={number}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={makeParcel}>
          Make a match parcel
        </button>
        {makeError && <p role="alert">{makeError}</p>}
      </fieldset>

      <form onSubmit={submit}>
        <label>
          Database
          <textarea value={databaseText} onChange={(e) => setDatabaseText(e.target.value)} />
        </label>
        <ol aria-label="Parcels">
          {parcels.map((parcel, index) => (
            <li key={index}>
              <label>
                Parcel {index + 1}
                <textarea
                  value={parcel}
                  onChange={(e) =>
                    setParcels((current) =>
                      current.map((p, i) => (i === index ? e.target.value : p)),
                    )
                  }
                />
              </label>
              <button
                type="button"
                onClick={() => setParcels((current) => current.filter((_, i) => i !== index))}
              >
                Remove parcel {index + 1}
              </button>
            </li>
          ))}
        </ol>
        <button type="button" onClick={() => setParcels((current) => [...current, ''])}>
          Add a parcel to paste
        </button>
        <button type="submit" disabled={busy}>
          Apply the parcels
        </button>
      </form>

      {answer && (
        <Answer answer={answer} onUseDatabase={(text) => setDatabaseText(text)} />
      )}
      <Link to="/">Go to the start page</Link>
    </section>
  )
}

const recordAnswers = {
  held: 'held',
  malformed: 'malformed',
  not_stored: 'not stored',
} as const

function Answer({
  answer,
  onUseDatabase,
}: {
  answer: ApplyAnswer
  onUseDatabase: (text: string) => void
}) {
  switch (answer.kind) {
    case 'not-json':
      return <p role="alert">The database is not JSON. Nothing was sent.</p>
    case 'invalid':
      return (
        <p role="alert">
          The api refused the request: the part at “{answer.pointer || '/'}” is
          not valid.
        </p>
      )
    case 'unknown':
      return <p role="alert">The api’s answer was not understood.</p>
    case 'applied':
      return (
        <section aria-label="Result">
          <h2>What happened to each parcel</h2>
          <ol aria-label="What happened to each parcel">
            {answer.parcels.map((parcel, index) => (
              <li key={index}>
                Parcel {index + 1}: {parcel.status}
                {parcel.reason && ` (${parcel.reason.replaceAll('_', ' ')})`}
                {parcel.records.length > 0 && (
                  <ul>
                    {parcel.records.map((record, at) => (
                      <li key={at}>
                        Record {record.recordId}: {recordAnswers[record.answer]}
                        {record.reason && ` (${record.reason.replaceAll('_', ' ')})`}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
          <h2>New database</h2>
          <label>
            New database
            <textarea readOnly value={answer.databaseText} />
          </label>
          <button type="button" onClick={() => onUseDatabase(answer.databaseText)}>
            Use the new database
          </button>
        </section>
      )
  }
}
