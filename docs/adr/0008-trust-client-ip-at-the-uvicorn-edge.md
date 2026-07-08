# Trust the client IP at the uvicorn edge, keyed on all-private ranges

## Status

accepted

## Context

Our IP-keyed rate limiters (the public match-details `60/min` anti-scrape
limit in `matches.py`, and the `email-ip` / `login-consume-ip` / IP-fallback
limiters in `sessions.py`) all bucket on `request.client.host`. Behind the
shipped nginx, `request.client.host` was the **nginx pod/container IP for every
external request**, because uvicorn's `--forwarded-allow-ips` defaults to
`127.0.0.1` and therefore refuses to trust the non-loopback nginx peer and
rewrite `request.client` from `X-Forwarded-For`. Result: every internet caller
shared one bucket, so the documented "per-IP … so an open URL can't be scraped
from a single source" was in fact a **global** cap — past ~1 req/s aggregate the
whole deployment 429'd single-request viewers, and the per-source anti-scrape
guarantee did not hold (issue #837).

The real client IP is *expected* to survive to the app (this has been reasoned
from config, not yet observed end-to-end on a live stack): host Caddy's bare
`reverse_proxy` appends the client IP to `X-Forwarded-For` by default, the k3d
NodePort SNAT is L3 and leaves the header intact, and nginx's
`$proxy_add_x_forwarded_for` appends its own peer. So the app should receive
`X-Forwarded-For: <client>, <snat-node>` with the nginx pod as the TCP peer —
every intermediate hop a **private** address and the real client **public**.
This premise is load-bearing: confirm the actual received `X-Forwarded-For`
(and resulting `request.client`) on the target stack before relying on the
guarantee, since a proxy that doesn't forward the client IP voids it.

## Decision

Restore the true, non-spoofable client IP **once, at the uvicorn transport
edge** — not per-limiter and not in the ingress — by setting the
`FORWARDED_ALLOW_IPS` environment variable to **all private/internal ranges**
(`10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8`) in the proxied
environments only (compose dev, compose qa, uat). uvicorn's
`ProxyHeadersMiddleware` then walks `X-Forwarded-For` right-to-left and returns
the first **untrusted** (i.e. first public) host, which is the real client, and
rewrites `request.client` process-wide. All five IP-keyed limiters are fixed by
this single config change with no edits to their key functions. Bare-metal
`uvicorn --reload` (no proxy) keeps the safe `127.0.0.1` default.

## Considered options

- **`FORWARDED_ALLOW_IPS=*`** — rejected. With "always trust", uvicorn returns
  the **leftmost** XFF entry, which is fully client-controlled. A scraper could
  forge `X-Forwarded-For` to rotate buckets and defeat the anti-scrape limit
  entirely — security theater.
- **Trust the nginx pod IP / pod CIDR only** — rejected. Behind the NodePort
  SNAT the rightmost XFF entry is the SNAT node IP (one value for all external
  traffic); trusting only the pod would return *that*, silently reproducing the
  global-bucket bug. Pod/node/SNAT IPs are also dynamic and stack-specific.
- **Rate-limit in the ingress (nginx `limit_req`)** — rejected. nginx has its
  own upstreams (Caddy, the SNAT'd NodePort, the tailscale sidecar), so it must
  solve the *same* trust problem in a weaker tool with no `real_ip` config
  today; it can't express the two-tier per-session-cookie email limits; and it
  would lose the Redis-shared counter state we have across api replicas.
- **App-layer key on nginx's `X-Real-IP`** — rejected. Re-implements proxy-trust
  in Python, must be threaded onto every limiter (easy to miss the next one),
  and leaves `request.client` lying to logs.

## Consequences

- **Spoof-resistant** because every genuine hop appends to the *right* of any
  client-forged value, so the reverse-walk reaches the real public client
  before any forgery — as long as the trusted set is private ranges and the
  real client is public. A legitimate client on a private/CGNAT address would
  be mis-attributed; acceptable for a public app.
- **Do not add the CGNAT range `100.64.0.0/10`** to the trust list "for the
  tailnet." On the tailnet path a `100.64.x` address is the *client* (set by
  `tailscale serve`), not a proxy hop — the sidecar→nginx hop is a pod-CIDR
  (`10/8`) address already covered. Trusting `100.64/10` would make the
  reverse-walk skip *past* the honest tailnet client. It is inert on the public
  path (internet clients present as public IPs) and harmful on the tailnet one.
- **Topology-independent** — "our hops are private, clients are public" holds
  whether the stack is k3d, a cloud load balancer, or a managed ingress later,
  so the value need not change when the deployment does.
- **nginx's `$proxy_add_x_forwarded_for` and Caddy's XFF append are now
  load-bearing.** Removing them silently breaks per-source limiting.
- **Misconfiguration is invisible** (unset env var → proxy IP, no error). A
  startup log line records the effective trusted ranges so any environment can
  be checked with one grep. A unit test pins the chosen trust list to the
  behavior (real client out, forgery ignored) so narrowing it fails CI.
