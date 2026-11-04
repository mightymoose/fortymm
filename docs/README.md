# docs

How each part of FortyMM works, in more detail than the `CLAUDE.md` files
hold. Read the doc for an area before you change it, and update the doc in
the same change when its behaviour changes. When a line stops being true,
delete it.

A "(see X)" in these docs names a section by its heading. This table says
which file holds it.

| Section | File |
| --- | --- |
| CI | `ci.md` |
| Accounts and sessions, Is this you?, Sign-in, Roles and permissions, Leagues | `accounts.md` |
| Matches, Signed match results, Approving a result, Overriding a result, Signing keys (api) | `matches-api.md` |
| Routing's pages: shell, account menu, Home, new match, "Is this you?", admin, public pages | `web-client-pages.md` |
| Scoring: the score page, the fragment, sync, submission and approval pages | `web-client-scoring.md` |
| API client, Signing keys (web-client), Error pages, Service worker | `web-client-data.md` |
| Tests, End-to-end tests, Post-deploy suite | `web-client-testing.md` |
| Deploy, web-client (Cloudflare Workers), api (Cloud Run), The database, The Worker secret, Auth0 | `deploy.md` |
| Routing, Styles, Dev server, Dependencies (web-client) | `../web-client/CLAUDE.md` |
| Migrations, OpenAPI schema and clients | `../api/CLAUDE.md` |
| ios-client | `../ios-client/CLAUDE.md` |

Other references:

- `../references/matches.md`: why matches work the way they do.
- `../api/signed-results/README.md`: the signed result format and its test
  vectors.
- `../api/deploy/README.md`: the one-time GCP and Auth0 setup.
- `../ios-client/README.md`: running the iOS app and releasing it.
