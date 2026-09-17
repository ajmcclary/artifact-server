# Immutable artifact engineering research intake

Imported on September 17, 2026 against code commit
`572e28f4beef971b94c9864408f5c067ad499ba1`. The user supplied two representations
of an engineering decision dossier. Both are retained byte-for-byte.

Read the [repository reconciliation](./RECONCILIATION.md) for applicability and
corrections, then the root [next steps](../../../NEXT-STEPS.md) for implementation
order, acceptance conditions, and gates. The dossier's recommendations are
research input, not instructions authorizing code changes, external services,
deployment, altered bridge behavior, or broader access.

## Preserved sources

| Source | Role |
| --- | --- |
| [Original Markdown](./sources/deep-research-report.md) | Full supplied research, 33 uncertainty entries, proposed acceptance statements, benchmark program, and source register. |
| [Original Word dossier](<./sources/Engineering Decision Dossier for Immutable Web-Artifact Publishing, Review, and Sharing.docx>) | Original presentation with citation hyperlink relationships. |
| [Source manifest](./source-manifest.json) | Byte lengths and SHA-256 hashes for both originals and imported prior-review records. |
| [DOCX inspection](./docx-inspection.json) | Read-only OOXML structure and external citation targets; 1,975 paragraphs, 22 tables, no tracked changes or comments. This is not layout qualification. |

The Markdown export contains opaque ChatGPT citation handles. They are preserved
as source material, but those handles are not usable proof links. Its source
register contains ordinary URLs. DOCX relationships retain additional targets,
including broad homepages; neither representation establishes a complete
claim-to-source mapping for every multi-source citation cluster. Do not guess
that mapping. The reconciliation links directly to the primary pages it checked.

The original report's A–N contract matrix refers to its supplied prompt:
A provider independence; B immutable bytes/IDs; C atomic publication after
durable blobs; D idempotency/current-version conflicts; E binary publication;
F trusted tenant/storage boundaries; G local-only links; H revocable authorization
and no shared private cache; I bridge citizenship; J non-authoritative Git;
K preview isolation; L no artifact builds/conversion; M operator-owned deployment;
N observable correctness and recovery evidence. These labels are not repository
requirement IDs.

## Prior review observations

[review-evidence](./review-evidence) contains copies from the preceding local
architecture review at the same code commit:

- [Git-order probe](./review-evidence/git-order-probe.json): eight real HTTP
  publications in a disposable SQLite installation, followed by production
  repository enablement/claim; first claim selected version 8. No Git provider
  was contacted. This is an ad hoc diagnostic, not a conformance acceptance run.
- [Verification summary](./review-evidence/verification-summary.json): the prior
  full gate and separate external performance command passed on Node 26.5.0.
- [Local](./review-evidence/local-performance-baseline.json),
  [capacity](./review-evidence/local-capacity-baseline.json), and
  [external](./review-evidence/external-storage-performance-baseline.json)
  reports: measurements from that prior run, including its event-loop and RSS
  investigation warnings. They are not paired optimization results.

Historical absolute paths inside these unchanged JSON records identify their
original execution environment; they are provenance, not portable commands.
New qualification runs belong in the normal evidence workflow. Importing these
files does not change ledger statuses or close deployment proof gaps.

## Integration outcome

The intake adds a bounded implementation backlog and corrects documentation
about present limits. It does not implement the proposed optimizations, add
subscriptions, change authorization/cache policy, upgrade dependencies, add
paid providers, or enable garbage collection. The existing GIT-008 proof-gap
description is corrected to match the observed implementation; its requirement,
acceptance tests, and `implementing` status remain intact.

[Integration validation](./validation/README.md) records the successful full gate
on Node 24.15.0, source/link checks, and the fresh capacity RSS warning. Those
results are separate from the preserved prior-review observations above.
