# Delivery baseline and streaming compression — design

Date: 2026-10-05
Status: approved in conversation; awaiting written-spec review
Source: [PLAN.md](../../../PLAN.md) step 0, at `9d13450`.

## Intent

Start the Artifact Server side of the design platform plan with its first
step: measure how prototypes and the Library actually reach the browser, then
fix the confirmed compression gap for version content. The reported symptom is
a roughly 20-second hosted prototype load. Source inspection shows that every
version-content response is served uncompressed by the Node runtimes, and that
ExtractionKit alone loads about 16 MB of mostly text resources. Neither fact is
a measured diagnosis; this work produces the measurement and a bounded fix.

### What the user decided

- This sub-project combines the delivery measurement harness (A) and streaming
  compression for version content (B). The server-side preview catalog,
  cache-policy and lease-reuse decisions, and all Design-repository work are
  separate sub-projects.
- No changes in `~/Dev/Design` while another agent is working there.
- The hosted measurement uses a headed sign-in once, with the saved browser
  state kept outside the repository.
- Prototype readiness is the preview iframe's `load` event followed by 500 ms
  with no requests in flight to its lease origin.
- Compression streams on the fly (approach 1). Precompressed variants keyed by
  digest and encoding (approach 2) are deferred until the baseline shows
  per-open compression CPU matters. Traefik middleware (approach 3) is not used.
- Done includes deploying to `artifacts.backend.app` and capturing hosted
  after-evidence, but only after the user explicitly approves the deploy.

### Assumptions

- `artifacts.backend.app` runs the external-storage Node runtime
  (`src/external-storage/start-external-storage-server.ts`) behind Traefik.
- Chromium through the repository's pinned `@playwright/test` is sufficient for
  delivery measurement; the cross-engine matrix is not required for this
  sub-project because Review sandboxing, leases, and comment convergence do not
  change.

## Current state

- `src/http/node-response-compression.ts` wraps the Node request listener. It
  compresses HTML, JavaScript, CSS, JSON, and SVG by buffering the whole body
  with `arrayBuffer()`, and skips any response carrying `Accept-Ranges: bytes`
  or `Content-Range`.
- `contentHeaders` in `src/http/create-http-app.ts` sets `Accept-Ranges: bytes`
  on every version-content response, so `serveStoredVersionContent` (preview
  leases, public current versions, and private content) is never compressed.
- `tests/http/node-response-compression.test.ts` asserts that range-capable
  content responses are never compressed. No ledger requirement mentions
  compression.
- The Cloudflare Workers deployment does not use the Node wrapper; it relies on
  edge compression.
- There is no version endpoint. The served `review-*.js` filename identifies
  the deployed web build.

## A. Delivery measurement harness

### Runner

`project/performance/run-delivery-baseline.ts`, invoked as
`pnpm perf:delivery`. It follows the existing `perf:*` runners and records the
machine and repository context through `project/performance/measurement-context.ts`.

Options:

| Option | Meaning | Default |
|---|---|---|
| `--target local` or `--target <https URL>` | Where to measure | `local` |
| `--label <text>` | Names the run in the report filename, such as `before` or `after` | required |
| `--samples <n>` | Samples per journey | 5 |
| `--deployment-revision <digest>` | Image digest recorded beside the detected `review-*.js` hash | none |
| `--prototype-url <Review URL>` | The hosted prototype to open, copied from the Library (ExtractionKit for this work) | required for hosted |
| `--content-domain <domain>` | The hosted content domain, used to classify lease and version-content hosts | required for hosted |
| `--state-root <directory>` | Where the session state and raw captures live | `~/.local/state/artifact-server/delivery` |
| `--output <path>` | The sanitized report path | `project/evidence/delivery-baseline-<date>-<target>-<label>.json` |

All runs are unthrottled and record the network as `unthrottled`. CDP
throttling applies per target and does not reliably cover the out-of-process
preview iframe, so a throttled profile would misstate the prototype journey.

### Targets

**Hosted.** On the first run, or when the saved state no longer authenticates,
the runner opens headed Chromium at the target and waits for the user to sign
in. It saves Playwright storage state to
`~/.local/state/artifact-server/delivery/hosted-session.json` with mode `0600`.
Later runs reuse that state headlessly. An expired state prompts a new sign-in
before any sample starts, never midway through a run.

**Local.** The runner starts an in-process local server (the same harness the
HTTP tests use, serving the compiled web bundle) in a temporary directory, signs
in as the local owner without loading any application page, and publishes a deterministic synthetic fixture shaped like ExtractionKit: one
HTML entry, a 1.7 MB JavaScript bundle, 1 MB of CSS, and 13 MB of seeded
JSON-like JavaScript data split across three files, plus a preview index so the
Library shows it. The report marks local runs as regression evidence whose
compression ratio is not representative of real fixtures.

### Journeys and samples

| Journey | Cold | Warm |
|---|---|---|
| Library | New browser context, open the Library, wait for Library-ready | Reload in the same context |
| Prototype | New browser context, open the selected preview in Review, wait for prototype-ready | Open it again in the same context |

**Library-ready** is the first gallery tile becoming visible.
**Prototype-ready** is the preview iframe's `load` event followed by 500 ms with
no requests in flight to that iframe's lease origin. A sample that does not
reach its ready signal within 120 seconds is recorded as a timeout, not dropped.

### Recorded per sample

- Requests by route class: `app-shell`, `api`, `preview-lease`,
  `version-content` (content-domain hosts that are not leases), `bootstrap`,
  `external-cdn`, `other`.
- Per class: request count, transferred bytes (Playwright's encoded response
  body size),
  decoded body bytes, and the observed values of `Content-Encoding`,
  `Cache-Control`, `Vary`, and `Server-Timing`.
- First contentful paint and the journey's ready time.
- For local runs, the harness process's CPU time during the sample. The server
  runs in that process, so the before/after difference approximates per-open
  compression CPU.
- Run context: target kind, browser version, cache state,
  detected `review-*.js` hash, optional deployment revision, sample index.

The report aggregates each journey's samples into median, minimum, and maximum.

### Privacy

The committed report is built only from allowlisted data: route class, a path
template (for example `/:artifact/:version/:path`, never a real path), the four
allowlisted response headers above, and numbers. It never contains a URL,
hostname, cookie, request header, query string, or body.

Raw HAR files (recorded without bodies) go to
`~/.local/state/artifact-server/delivery/<runId>/`, with the directory created
`0700` and every file `0600`. The runner refuses any raw-output path that
resolves inside the repository root.

### Output

- `project/evidence/delivery-baseline-<date>-<target>-<label>.json`.
- Before writing, the runner collects every lease hostname, query value, cookie
  value, and authorization value it saw and refuses to write a report containing
  any of them.
- A new "Browser delivery" section in `project/performance/FINDINGS.md` with the
  before and after tables and the per-open compression CPU measured locally.

### Tests

Unit tests for the report builder and the classifier, with no browser:

- **Hostile:** a synthetic capture containing `Cookie`, `Set-Cookie`,
  `Authorization`, bootstrap tokens in query strings, `review-<56 hex>` lease
  hostnames, private artifact paths, and response bodies produces a report
  whose serialized JSON contains none of them.
- **Hostile:** a raw-output path inside the repository root, including through
  a symbolic link, is rejected before any capture starts.
- **Normal:** each route class is classified correctly, path templates replace
  identifiers, and median/minimum/maximum aggregation is correct, including
  with timeouts present.

## B. Streaming compression for version content

### Components

- `src/http/content-encoding.ts`: the compressible media-type set, the 1 KiB
  minimum, `Accept-Encoding` negotiation (moved out of
  `node-response-compression.ts` so both paths share one definition), and the
  narrow `ContentEncoder` port,
  `encode(body: ReadableStream<Uint8Array>, coding: "br" | "gzip", sizeHint: number): ReadableStream<Uint8Array>`.
- `src/http/node-content-encoder.ts`: the `node:zlib` implementation adapted to
  web streams. Keeping it separate means the Workers bundle never imports
  `node:zlib`.
- `HttpAppDependencies.contentEncoder?: ContentEncoder`. The local and
  external-storage compositions inject the `node:zlib` implementation. The
  Workers composition injects nothing, so Workers responses are unchanged and
  its edge compression stays in charge.

### Eligibility

`serveStoredVersionContent` compresses a response only when all of these hold:

1. A `contentEncoder` is configured.
2. The method is `GET`.
3. The request has no `Range` header, and the range decision is `full`.
4. The entry's media type is in the shared compressible set and its size is at
   least 1 KiB.
5. Negotiation selects `br` (quality 4) or `gzip` (level 6), preferring `br`.
   A missing `Accept-Encoding`, an `identity`-only request, or `q=0` for both
   codings selects neither.

Every other response is served exactly as today: identity bytes,
`Accept-Ranges: bytes`, `Content-Length`, and the strong ETag. This includes
206, 416, a `Range` request whose `If-Range` fails, refusals, and
non-compressible types. The `/file`, `/media`, and `/archive` routes are not
changed.

### Headers

For an encoded response:

- `Content-Encoding` is set to the selected coding.
- `Content-Length` and `Accept-Ranges` are removed. Ranges apply only to the
  identity representation.
- `ETag` becomes `W/"<sha256>"`.
- `Vary: Accept-Encoding` is appended.
- `Cache-Control` is unchanged: leases stay `private, no-store`, public current
  versions stay `public, no-cache, must-revalidate`, and private content stays
  `private, no-store`.

An identity response for a compressible type also carries
`Vary: Accept-Encoding`. `HEAD` returns the headers its matching `GET` would
return. A 304 is already produced for `If-None-Match: W/"<sha256>"`. A later
`If-Range: W/"<sha256>"` fails the strong comparison required by RFC 9110 and
receives an identity full response. A 304 never carries `Content-Encoding`, so
a cache that holds the identity bytes cannot relabel them as encoded when it
merges the 304's headers.

### Streaming, cancellation, and errors

The blob's `ReadableStream` is piped through the zlib transform with the
socket providing backpressure. Cancelling the response body (a client
disconnect) cancels the transform and the underlying blob read. A storage error
after headers are sent aborts the response, as it does today. Memory per
response is bounded by the zlib window and stream high-water marks, not by the
artifact's size.

### Interaction with the buffering wrapper

Every version-content response now carries either `Content-Encoding` or
`Accept-Ranges`, so `withNodeResponseCompression` passes it through without
buffering. A test asserts this invariant. The wrapper's comment is updated to
describe it, and the wrapper continues to serve the application's in-memory
assets.

### Tests

All run against a real HTTP server, temporary disk storage, and a temporary
SQLite database. No module mocks.

**CNT-010-B**

- `br` and `gzip` responses for a preview lease, a public current version, and
  private content decode to the exact stored bytes.
- Encoded responses carry the weak ETag, `Vary: Accept-Encoding`, no
  `Content-Length`, and no `Accept-Ranges`. Identity responses for the same
  entry carry `Vary: Accept-Encoding` and the strong ETag.
- `HEAD` headers match the corresponding `GET`.
- `If-None-Match: W/"<sha256>"` returns 304 with `Vary`.

**CNT-010-F**

- `Range` with `Accept-Encoding: gzip` returns an identity 206 with the correct
  `Content-Range`.
- `Range` with `If-Range: W/"<sha256>"` returns an identity 200 with
  `Accept-Ranges: bytes`.
- An unsatisfiable range still returns 416.
- `Accept-Encoding: identity` and `br;q=0, gzip;q=0` return identity.
- A binary type returns identity with range support.
- A client disconnect after the first chunk of a 64 MiB compressible entry
  stops the read early: an instrumented decorator over the real disk blob store
  records fewer than 8 MiB read from the 64 MiB entry.
- Twenty concurrent full reads of a 64 MiB compressible entry grow
  `heapUsed + external + arrayBuffers` by less than 256 MiB, a fifth of the
  1.25 GiB that buffering every body would hold.
- Every version-content response passes through the buffering wrapper
  unbuffered.

The existing test `foundation: range-capable content responses are never
compressed` is replaced by these tests. The CNT-008 tests must keep passing
unchanged.

## Conformance and product spec

Add one sentence to the `architecture` section of
`project/spec/artifact-server-product-spec.html`: eligible full content
responses are compressed when the client accepts it, and range requests stay on
the identity representation.

Add CNT-010 to `project/spec/conformance.yml`:

```yaml
  - id: CNT-010
    kind: behavior
    behavior: Eligible full content responses are compressed when the client accepts it, without buffering the artifact, while range requests and refusals stay on the identity representation.
    owner: content-delivery
    source: {file: artifact-server-product-spec.html, anchor: architecture}
    acceptance:
      behavior: {id: CNT-010-B, description: "Serve an eligible full GET as br or gzip that decodes to the exact stored bytes, with consistent HEAD, 304, Vary, and weak validator behavior."}
      failure: {id: CNT-010-F, description: "Range, If-Range, identity or q=0 refusals, and non-compressible types are served identity with ranges intact; a disconnect stops the storage read; concurrent large reads stay within the memory bound."}
    deployments: *all
    status: implementing
    proof_gap: Cloudflare relies on edge compression and needs its own live qualification, which this work does not authorize.
    depends_on: [CNT-008]
    evidence: []
```

Once the local test run passes, the ledger validator requires
`behavior_verified` with local evidence (`project/evidence/local-foundation.json`).
The hosted after-run is a browser observation, not a conformance test run, so
it is recorded in FINDINGS and named in `proof_gap` rather than attached as
Kubernetes ledger evidence.

## Sequence

1. On branch `delivery-compression`, build harness A with its tests.
2. Capture the local before run on the current `main` server code.
3. The user signs in once; capture the hosted before run. This must precede any
   deploy.
4. Implement B test-first. Run `pnpm smoke`, then `pnpm perf:baseline` before
   and after on the same machine, then the local after run.
5. Run `pnpm verify:iteration`. Report any failure as it stands.
6. **Stop for the user's explicit approval to deploy.** Then merge to `main`,
   push, run `image.yml`, read the digest from the "Print digest" step only,
   update both Workspace GitOps pins, and verify all four
   `app.kubernetes.io/component=server` pods run the new digest and `/review`
   serves the expected `review-*.js` hash. Roll back by reverting the
   Workspace pin commit.
7. Capture the hosted after run. It also shows whether Traefik passes encoded
   content through end to end; a stripped or double-encoded response is
   recorded as a finding, not patched quietly.
8. Write the FINDINGS "Browser delivery" section and attach CNT-010 evidence.

## Out of scope

- Cache-policy and lease-reuse decisions (PLAN.md step 0, separate contract
  decision).
- The `/file`, `/media`, and `/archive` routes.
- Precompressed variants; reconsidered with the measured per-open CPU.
- Cloudflare Workers changes or live Cloudflare runs.
- The server-side preview catalog (PLAN.md step 1).
- Any change in `~/Dev/Design`.

## Done

- CNT-010-B and CNT-010-F pass; CNT-008 tests pass unchanged.
- `pnpm verify:iteration` passes, or each failure is reported with its output.
- Sanitized local and hosted before/after evidence is committed, and the
  FINDINGS section is written.
- A search of committed evidence for cookie, authorization, token, bootstrap,
  and `review-` hostname patterns finds nothing.
