# 0029: Upload URLs authorize themselves

**Status:** Accepted
**Date:** September 14, 2026

## Decision

The per-file upload URL returned by `artifact_create_upload` carries everything
the write needs: the upload, the project, the owner, and one unguessable per-file
token. `PUT /api/v1/uploads/{upload}/files/{token}` takes no credential at all.
It is the one route under `/api/` that skips authentication, and it ignores any
Authorization header or session cookie that arrives with it.

`files[].authorization` reads `{credential: "included_in_upload_url", scheme:
"none"}`, and the publishing instruction tells the agent to send no Authorization
header.

## Why

The staged-upload contract assumed that whoever calls the MCP tool also holds the
credential the upload URL needs. That is true for an agent talking to this server
directly and false the moment a gateway sits in between. An agent behind an MCP
gateway presents the gateway's key, the gateway presents the person's token
upstream, and the upload URL comes back addressed to a credential the agent will
never see. Such an agent creates a staged upload it cannot fill: the `PUT` is
refused and `artifact_commit_upload` answers `UPLOAD_INCOMPLETE`.

Publication is the product. A deployment that gives agents per-person identity
through a gateway but cannot publish through it has traded the main feature for
the audit trail.

## What the URL grants, and what it costs

Holding the URL allows writing bytes whose SHA-256 equals the digest its owner
declared when the upload was created. Everything else is refused: the URL cannot
read the file, commit, name, tag, or version anything, and it names one file
inside one upload.

Two costs come with that, and neither is zero.

**It answers questions.** The digest is not in the URL, but the response tells
the holder whether a guess matched: 200 for the declared bytes, 422 for anything
else. For a small file with a guessable shape that is a confirmation oracle for
as long as the upload lives. Before this change the same oracle existed for
anyone holding the owner's credential.

**It holds connections.** An anonymous writer can open writes and feed them
slowly. One write now gets its own ten-minute deadline rather than the upload's
full hour, but nothing rate-limits how many are opened.

Both are bounded by the upload's lifetime and by the fact that the slot's content
is already determined. Neither is a reason to keep a credential on this route,
because the credential a gateway client would send is one this server cannot
read.

## Recorded decisions

### The route takes no credential rather than accepting an optional one

An earlier draft authenticated the request when a credential was present and fell
back to the token when none was. That fails the exact client this change exists
for: an HTTP client configured with a default Authorization header sends the
gateway key, the server cannot verify it, and the upload dies with 401 instead of
falling through. A route whose authorization lives in its URL must not change
behavior because of a header it never needed.

### The owner travels in the URL, and the storage layer keeps its shape

The repository finds one upload file slot by project, upload, owner, and token.
The owner is an identifier, not a claim: naming the wrong owner or token gives
the same 404 body before any status or expiry information is returned. The
lookup keeps the current single-file database query rather than loading a full
upload manifest for every file write.

### A failed write leaves the slot unverified

Bytes that miss the declared digest are rejected before the file is marked
uploaded, so a wrong guess cannot make `artifact_commit_upload` publish it.

## Rejected alternatives

### Let the gateway proxy the upload

The upload is a plain HTTPS `PUT` to this server, not an MCP call, so a gateway
would have to grow a second, artifact-server-shaped API. That is not a change
this project can make in someone else's gateway.

### Scope staged uploads to the member instead of the principal

This would let a person finish an upload with any of their own credentials, and
it does nothing for the case at hand: the agent behind the gateway holds no
credential of that person at all.

### Hand out presigned object-storage URLs

The digest check happens while the bytes stream through this server. Moving the
write to object storage moves verification to commit time and changes what
`verified` means on every deployment, including the ones with no object storage.
