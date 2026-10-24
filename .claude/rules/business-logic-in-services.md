# Business logic lives in services

The rules of the domain live in service functions, not in routes, dependencies
or middleware. A rule is anything that decides what the system does, such as
which session is valid, when a guest account starts, or what adoption moves.

The HTTP layer only translates. It parses the request into plain values,
calls one service, and turns the result into a response, a status code, a
header or a cookie. It holds no decision that a second entry point, such as a
worker, a CLI or a later API version, would have to copy.

## Why

- One home for each rule. A second route or a background job calls the same
  service, so the rule can't drift between copies.
- A service is testable without HTTP. A test calls it with a database session
  and values, and checks what it returns and writes.
- A reader finds the rule where its name says. They don't have to trace it
  through framework wiring.

## How to tell

- If code branches on domain state, it belongs in a service.
- If code reads a header or a cookie, or sets a status code, it belongs in the
  HTTP layer.
- A service returns domain types. It never takes or returns a request, a
  response or a framework exception.
