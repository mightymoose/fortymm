# Auth0 Action: email claims on the MCP access token

The MCP auto-provision/match feature (issue #1157, ADR
`20260722-mcp-accounts-auto-provision-and-match-by-verified-auth0-email.md`)
needs the agent's Auth0 **access token** to carry the caller's email and its
verified flag. A custom-API access token does **not** carry profile claims by
default, so without the Action below every unlinked token is refused (401) and no
account is ever provisioned or matched.

## The claim keys the verifier reads

Auth0 **silently drops non-namespaced custom claims**, so these must be namespaced
URLs — they cannot be bare `email` / `email_verified`. The FortyMM MCP verifier
reads exactly these two keys off the verified access token:

| Claim key | Value |
| --- | --- |
| `https://fortymm.com/email` | the user's email address (string) |
| `https://fortymm.com/email_verified` | whether Auth0 has verified it (boolean) |

If you change the namespace here, you must change the constants the verifier reads
(`app/auth0_provisioning.py`) in the same breath, or the feature goes dark.

## The Action

In the Auth0 dashboard: **Actions → Library → Create Action** (or **Triggers →
Login / post-login → Add Action → Build from scratch**). Name it e.g.
`mcp-email-claims`, trigger **Login / Post Login**, and paste:

```js
/**
 * Add the caller's email + verified flag to the access token so the FortyMM MCP
 * Resource Server can auto-provision / match a FortyMM account by verified email.
 * Auth0 drops non-namespaced custom claims, so both keys are namespaced.
 */
exports.onExecutePostLogin = async (event, api) => {
  const NS = 'https://fortymm.com';
  if (event.user.email) {
    api.accessToken.setCustomClaim(`${NS}/email`, event.user.email);
    api.accessToken.setCustomClaim(
      `${NS}/email_verified`,
      event.user.email_verified === true,
    );
  }
};
```

Then **Deploy** the Action and, in the **Login / Post Login** trigger flow, drag
it into the flow and **Apply** so it runs on every login.

### Optional: scope the claims to the MCP API only

The Action above sets the claims on every access token the tenant issues. FortyMM
only uses this tenant for the MCP API, so that's harmless. If you later add other
APIs and want to avoid putting email on their tokens, guard on the requested
audience — but note the post-login trigger does not always expose the requested
resource-server identifier, so test before relying on it.

## Verifying it works end to end

1. Deploy + apply the Action.
2. On UAT, add the FortyMM MCP server as an OAuth connector in an agent host and
   log in with a verified email.
3. Decode the issued access token (jwt.io) and confirm it carries
   `https://fortymm.com/email` and `https://fortymm.com/email_verified: true`.
4. A first-time email should now auto-provision a FortyMM account; a matching
   email should bind to the existing one. An account holding `mcp.access` can then
   call tools.
