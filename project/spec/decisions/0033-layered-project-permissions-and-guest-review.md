# 0033: Layered project permissions and guest review

**Status:** Accepted
**Date:** October 26, 2026
**Supersedes in part:** [ADR 0015](0015-project-scoped-artifacts.md) ("Projects do not have their own member list or access-control list"), [ADR 0019](0019-artifact-comments.md) (public-link viewers never see comments)

## Decision

The installation stays the trust boundary. Inside it, access is resolved from
five layers, evaluated on every request:

1. **Installation policy** (administrators): ceilings that nothing below can
   exceed. These cover whether share links are allowed, the most a share link
   may grant, a maximum link expiry, who may create links, the default mode for
   new projects, and an optional permission ceiling for every member.
2. **Installation role:** a human administrator is a manager on every project.
   An administrator cannot receive a grant and cannot be blocked.
3. **Project:** each project is *open* (every member gets the project's default
   role) or *restricted* (only members with a project grant). A member's own
   project grant replaces the default rather than merging with it, so a grant of
   `none` blocks one person on an open project.
4. **Artifact:** an artifact grant adds access to one artifact. Share links give
   people without an account a bounded set of permissions on one artifact
   version target.
5. **State:** an archived project removes every write permission, a deleted
   artifact removes everything, and an expired grant is ignored.

Grants are additive across layers. Ceilings and state only remove permissions,
and they always win. A grant may add or remove individual permissions, and
those overrides apply only to that grant.

There are eleven permissions: `artifact.view`, `artifact.history`,
`comment.read`, `comment.write`, `comment.moderate`, `artifact.publish`,
`artifact.edit`, `artifact.delete`, `artifact.share`, `agent.dispatch` and
`project.manage`. The roles are ordered:

| Role | Adds |
| --- | --- |
| none | nothing |
| viewer | `artifact.view`, `artifact.history`, `comment.read` |
| commenter | `comment.write` |
| editor | `artifact.publish`, `artifact.edit`, `artifact.delete`, `artifact.share`, `agent.dispatch` |
| manager | `comment.moderate`, `project.manage` |

`editor` is exactly what an admitted member could do before this decision. Every
existing project therefore upgrades to *open* with default role `editor`, and no
one's access changes.

Service keys and member-bound keys keep their explicit capability rules. A key
may also be scoped to a list of projects, and an empty list means every
project. A member-bound key passes only when its capability rule, its project
scope and its member's effective permissions all allow the operation.

**Guests** are a third principal kind. A guest is created when someone opens a
share link. Guests authenticate only through the share-link routes with their
own cookie, and can hold only `artifact.view`, `comment.read` and
`comment.write` on the link's version target. A guest names themselves before
their first comment. Guest comments are always labeled as guest-authored, and
reach agents with a fixed untrusted-input marker.

The existing bare public link (`/artifacts/:artifactId` opening the current
version) is unchanged. Share links are separate records that always open
Review. Making an artifact account-required turns off its bare link and revokes
its share links.

A principal that cannot view a project or artifact receives the same not-found
response as for an identifier that does not exist.

## Consequences

SCP-008 no longer holds; PRM-001 through PRM-010 replace it. Comments may now
be read and written through a share link, but are still never served from the
content origin. Every scoped authorization check now names its project and
artifact, so a check can no longer run before its project is resolved.

Because administrators are managers everywhere, and the installation already
refuses to lose its last active administrator, every project always has a
manager without further rules.
