/** The API's error envelope (FastAPI's `{"detail": ...}`). Union it into a
 * resolver's response type so tests can drive inline failure paths (e.g. a
 * 409 `detail`) through the same typed resolver as the happy path. */
export type ErrorBody = { detail: string };

/** A **coded** error envelope — `{"detail": {"code": …, "message": …}}` — the
 * shape the API uses where the refusal has to be machine-readable: the
 * session-ended 401s (`sessions.py`) and every tournament-entry refusal
 * (ADR-0968). The `code` is the contract a client switches on; the `message` is
 * prose it falls back to only for a code it does not know. */
export type CodedErrorBody = { detail: { code: string; message: string } };

/** FastAPI's 422 `ValidationError` envelope (`detail` is a list of per-field
 * errors carrying `loc`/`msg`). Union it into a resolver's response type to
 * drive field-mapped 422 paths through the typed resolver.
 *
 * `type` and `input` are optional here but are **always** present on the wire:
 * Pydantic v2 echoes the offending value back in `input`. They are modelled so a
 * test can seed a realistic body and assert that neither the machinery nor the
 * echoed value reaches the UI — `extractDetail` reads `msg` alone, deliberately,
 * and a fixture that omitted `input` could not prove it. */
export type ValidationErrorBody = {
  detail: {
    loc: (string | number)[];
    msg: string;
    type?: string;
    input?: unknown;
  }[];
};
