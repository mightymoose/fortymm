/** The API's error envelope (FastAPI's `{"detail": ...}`). Union it into a
 * resolver's response type so tests can drive inline failure paths (e.g. a
 * 409 `detail`) through the same typed resolver as the happy path. */
export type ErrorBody = { detail: string };

/** FastAPI's 422 `ValidationError` envelope (`detail` is a list of per-field
 * errors carrying `loc`/`msg`). Union it into a resolver's response type to
 * drive field-mapped 422 paths through the typed resolver. */
export type ValidationErrorBody = {
  detail: { loc: (string | number)[]; msg: string }[];
};
