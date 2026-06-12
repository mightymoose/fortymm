/** The API's error envelope (FastAPI's `{"detail": ...}`). Union it into a
 * resolver's response type so tests can drive inline failure paths (e.g. a
 * 409 `detail`) through the same typed resolver as the happy path. */
export type ErrorBody = { detail: string };
