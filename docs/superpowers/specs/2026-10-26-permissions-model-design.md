# Permissions model — design

Date: 2026-10-26
Status: draft, for review
Source: the permissions brief of 2026-10-26. The user skipped the brainstorming questions, so every product choice below is marked as either **brief** (the brief asked for it) or **my call**.

## Intent

Today one rule covers everything. An admitted human member can read, publish, share and delete in every project. An installation administrator also manages members and keys. A service key carries installation-wide capabilities. A public link shows the current version and nothing else: no comments and no Review controls (`SCP-008`, `CMT-006`, product spec "Access and mutation policy").

The brief asks for five things:

1. Grant people access to specific projects. **brief**
2. Add more layers of privilege on top of that. **brief**
3. Configure access from the interface. **brief**
4. Let people without an account see Review controls and comment when a link allows it. **brief**
5. Control every permission individually. **brief**

### Goals

- Restrict a project to named members, and give each of them a role on it.
- Override a single permission for one person on one project or artifact.
- Create share links that give people without an account a defined set of Review abilities, including commenting under a guest identity.
- Let installation administrators set ceilings that no project or link can exceed.
- Answer "why can this person do this?" from the interface, for any person, project or artifact.

### Non-goals

- Groups, SCIM or directory sync. The existing access spec defers these, and the schema leaves room for them.
- More than one organization per installation. The installation is still the trust boundary (ADR 0015).
- Showing version history or comparisons to guests. A share link reaches only its own version target. **my call**, matching today's public-link rule.
- Holding guest comments for approval. Members delete unwanted guest comments instead. **my call**, deferred.
- Custom named roles defined by administrators. Per-grant overrides cover this need. **my call**

### Anti-goals (failures even if it works)

- An existing installation loses or gains any access when it upgrades.
- A guest's words can be mistaken for a member's, or reach an agent without being marked untrusted.
- Someone grants a permission they don't hold themselves.
- An administrator can be locked out of a project, or the last project manager can be removed.
- A link leaks history, other artifacts, or comments on other versions.

## Concepts

```text
Installation  (trust boundary, policy ceilings, admin/member role)
└── Project   (access mode, default member role, project grants)
    └── Artifact   (artifact grants, share links)
        └── Version   (share links can pin one version)
```

**Principals** gain one kind. Today there are `human` and `service`. This adds `guest`, a person without an account who is known only through one share link and identified by the name they typed.

**Permissions** are fixed, named atoms. They are the unit of "granular control". Each one guards one class of operation.

| Permission | Guards | Can a guest hold it? |
| --- | --- | --- |
| `artifact.view` | Open the version target in Review and serve its bytes | yes |
| `artifact.history` | Version list, earlier versions, comparisons, file and archive downloads | no |
| `comment.read` | See threads and replies on the viewable version | yes |
| `comment.write` | Create threads, reply, resolve and reopen; edit and delete your own comments | yes |
| `comment.moderate` | Delete anyone's comment (never edit it, per the CMT owner's rule) | no |
| `artifact.publish` | Publish a new version, create an artifact in the project | no |
| `artifact.edit` | Rename, change tags, restore a version | no |
| `artifact.delete` | Delete the artifact | no |
| `artifact.share` | Create, change, rotate and revoke share links; add artifact grants | no |
| `agent.dispatch` | Send and cancel agent dispatches | no |
| `project.manage` | Rename, archive, Git-history switch, access mode, default role, project grants | no |

**Roles** are fixed, ordered bundles. Each role holds every permission of the roles below it.

| Role | Adds |
| --- | --- |
| `none` | nothing (an explicit block on an open project) |
| `viewer` | `artifact.view`, `artifact.history`, `comment.read` |
| `commenter` | `comment.write` |
| `editor` | `artifact.publish`, `artifact.edit`, `artifact.delete`, `artifact.share`, `agent.dispatch` |
| `manager` | `comment.moderate`, `project.manage` |

Today's member maps to `editor` on every project: they can publish, delete, share and change access, but cannot moderate other people's comments or manage projects. The default role for open projects is therefore `editor`, so the upgrade changes no one's access. **my call**, required by the first anti-goal (corrected during planning; see the end of this document).

## Permission hierarchy and resolution

There are five layers. Two of them only take permissions away (ceilings and state). Three of them grant.

| Layer | Set by | Effect |
| --- | --- | --- |
| L0 Installation policy | Installation administrator | Ceilings. Removes permissions everywhere and nothing below can restore them. |
| L1 Installation role | Installation administrator | `administrator` is implicitly `manager` on every project and can't be restricted. `member` gets nothing implicitly. |
| L2 Project | `project.manage` | Access mode (`open` or `restricted`), the default member role, and per-member project grants. |
| L3 Artifact | `artifact.share` | Artifact grants (additive only) and share links (guest grants). |
| L4 State | The system | An archived project or a deleted artifact removes every write permission. A revoked or expired link removes everything it gave. |

### Resolution algorithm

`effective(principal, artifact)` is computed fresh on every request. Nothing about it is cached across requests beyond the existing authentication-cache staleness window.

```text
1. If principal.installation ≠ installation → deny all.
2. Collect grants:
   a. human administrator          → role manager, no overrides (cannot be blocked)
   b. project grant for principal  → its role ± its overrides            (replaces 2c)
   c. else if project.mode = open  → project.default_member_role
   d. artifact grants for principal→ each role ± its overrides            (additive)
   e. guest                        → the share link's permission set only
3. granted = ⋃ over collected grants of ( role_permissions(role) ∪ add − remove )
4. Service principals: granted ∩ key.capabilities_as_permissions ∩ key.project_scope.
   An agent acting for a human: granted(human) ∩ connection capabilities.
5. effective = granted ∩ L0 ceilings(principal kind) ∩ L4 state mask.
```

The rules this produces:

- **A more specific project grant replaces the default.** It doesn't merge with it. This is how you block one person (`none`) or limit one person (`viewer`) on an open project.
- **Overrides apply only to their own grant.** If a project grant removes `artifact.delete` and an artifact grant adds it back for one artifact, the person can delete that one artifact. This is deliberate: a narrower grant is a narrower decision.
- **Grants are additive across layers. Ceilings and state are subtractive and always win.** No grant can beat L0 or L4.
- **Administrators can't be blocked at L2 or L3.** L0 still applies to them. Even an administrator can't create a public link when the installation disables public links.
- **Seeing an artifact needs `artifact.view` on it.** Listings, search, the activity feed, the command palette, MCP list tools and project summaries filter on this. A project the principal can't view anything in disappears entirely, and a direct ID returns `NOT_FOUND`, never `FORBIDDEN`, so nothing is disclosed.

### Installation policy ceilings (L0)

| Setting | Default | Effect |
| --- | --- | --- |
| `share_links.enabled` | on | Off stops every share link from serving. This is the existing "disable public links" switch. |
| `share_links.guest_permissions_max` | `artifact.view`, `comment.read`, `comment.write` | The most a link can grant. Narrowing it immediately narrows every existing link. |
| `share_links.max_expiry_days` | none | Every new link must expire within this many days. Existing links keep their expiry until they are edited. |
| `share_links.allowed_creator_role` | `manager` | Who may create links: `manager`, or administrators only. |
| `projects.default_mode` | `open` | The access mode of newly created projects. |
| `members.member_ceiling` | all | A permission set that no member can exceed through any grant (for example, no member may `artifact.delete`). |

### Service keys

API keys keep their capability list. Each capability maps to a set of permissions (for example, `artifact:read` maps to `artifact.view` + `artifact.history` + `comment.read`). Keys gain an optional `project_ids` scope. Empty means all projects, which is today's behavior. A key owned by a human can never exceed that human's own effective permissions on the same artifact.

## Data schema

The tables are written in the SQLite/Postgres/D1 shape used by `src/storage/invitation-schema.ts`. Every table is keyed by `installation_id` first. Every foreign key includes `installation_id`, so a caller-supplied ID can never cross installations (ADR 0015).

```sql
-- L0
CREATE TABLE installation_access_policy (
  installation_id TEXT PRIMARY KEY,
  policy_json TEXT NOT NULL,          -- validated document, see "Policy document"
  revision INTEGER NOT NULL,          -- optimistic concurrency
  updated_at TEXT NOT NULL,
  updated_by_principal_id TEXT NOT NULL
);

-- L2: two new columns on projects
ALTER TABLE projects ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'open'
  CHECK (access_mode IN ('open', 'restricted'));
ALTER TABLE projects ADD COLUMN default_member_role TEXT NOT NULL DEFAULT 'editor'
  CHECK (default_member_role IN ('none','viewer','commenter','editor','manager'));

-- L2 and L3 member grants share one shape
CREATE TABLE access_grants (
  installation_id TEXT NOT NULL,
  id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project', 'artifact')),
  project_id TEXT NOT NULL,
  artifact_id TEXT,                    -- NULL iff scope_kind = 'project'
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('member', 'service')),  -- 'group' reserved
  subject_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('none','viewer','commenter','editor','manager')),
  add_permissions_json TEXT NOT NULL DEFAULT '[]',
  remove_permissions_json TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT,                     -- optional time-boxed access
  created_at TEXT NOT NULL,
  created_by_principal_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (installation_id, id),
  UNIQUE (installation_id, scope_kind, project_id, artifact_id, subject_kind, subject_id),
  CHECK ((scope_kind = 'project') = (artifact_id IS NULL)),
  CHECK (scope_kind = 'project' OR role <> 'none'),     -- artifact grants are additive only
  FOREIGN KEY (installation_id, project_id) REFERENCES projects(installation_id, id)
);

-- L3 share links (replaces artifacts.access_setting = 'public_link')
CREATE TABLE share_links (
  installation_id TEXT NOT NULL,
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  label TEXT NOT NULL,                 -- "Client review — Acme", 1..80 chars
  token TEXT NOT NULL,                 -- ≥128-bit random; legacy rows keep their public ID
  target TEXT NOT NULL CHECK (target IN ('latest', 'pinned')),
  pinned_version_id TEXT,              -- NOT NULL iff target = 'pinned'
  permissions_json TEXT NOT NULL,      -- subset of guest-holdable permissions; must include artifact.view
  review_controls INTEGER NOT NULL CHECK (review_controls IN (0, 1)),  -- 0 = bare content (legacy)
  expires_at TEXT,
  created_at TEXT NOT NULL,
  created_by_principal_id TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by_principal_id TEXT,
  legacy_public_link INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (installation_id, id),
  UNIQUE (token),
  CHECK ((target = 'pinned') = (pinned_version_id IS NOT NULL)),
  CHECK ((revoked_at IS NULL) = (revoked_by_principal_id IS NULL)),
  CHECK (review_controls = 1 OR permissions_json = '["artifact.view"]')
);

-- Guests, one per browser per link
CREATE TABLE guest_principals (
  installation_id TEXT NOT NULL,
  id TEXT NOT NULL,                    -- 'guest:gst_…', stable author ID for comments
  share_link_id TEXT NOT NULL,
  display_name TEXT NOT NULL,          -- sanitized, 1..60 chars
  contact_email TEXT,                  -- optional, unverified, visible to members only
  created_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, id),
  FOREIGN KEY (installation_id, share_link_id) REFERENCES share_links(installation_id, id)
);

CREATE TABLE guest_sessions (
  installation_id TEXT NOT NULL,
  id TEXT NOT NULL,
  guest_id TEXT NOT NULL,
  token_digest TEXT NOT NULL,
  csrf_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,            -- min(link expiry, 30 days)
  revoked_at TEXT,
  PRIMARY KEY (installation_id, id),
  UNIQUE (installation_id, token_digest)
);

-- Service-key project scope
ALTER TABLE managed_api_keys ADD COLUMN project_ids_json TEXT NOT NULL DEFAULT '[]';
```

`artifacts.access_setting` stays as a derived, read-only column. It reads `public_link` exactly when the artifact has an active share link. Existing readers and the CDN purge path keep working without change.

### Policy document

```json
{
  "shareLinks": {
    "enabled": true,
    "guestPermissionsMax": ["artifact.view", "comment.read", "comment.write"],
    "maxExpiryDays": null,
    "allowedCreatorRole": "manager"
  },
  "projects": { "defaultMode": "open" },
  "members": { "memberCeiling": null }
}
```

### Effective-access response (for the interface and the "why" explainer)

```json
{
  "principal": { "id": "mem_…", "kind": "human", "displayName": "Dana" },
  "artifactId": "art_…",
  "permissions": ["artifact.view", "comment.read", "comment.write"],
  "sources": [
    { "layer": "project", "grantId": "grt_…", "role": "commenter", "removed": [] },
    { "layer": "policy", "ceilingRemoved": ["artifact.delete"] }
  ]
}
```

### Audit

New action kinds are recorded in the existing `actions` ledger with principal and authorizer: `grant_create`, `grant_update`, `grant_delete`, `project_access_change`, `policy_change`, `share_link_create`, `share_link_update`, `share_link_rotate`, `share_link_revoke`, `guest_join`. Guest comment actions record the guest principal and `authorized_by = share_link.created_by_principal_id`.

## Public (guest) review and comment flow

1. A person opens `https://<app>/s/<token>` on the application origin, not the content origin. The page is sent with `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex, nofollow`.
2. The shell posts the token to `POST /api/share/session`. The server checks that the link is active and not expired, that L0 allows it, and that the artifact and version are live. It then returns a guest session cookie (HttpOnly, Secure, SameSite=Lax) plus a CSRF token, and replaces the URL with `/s/<link-id>` so the token leaves the address bar and history.
3. Review opens in **Interactive** preview, as every Review page does. The version bytes load from the content origin through the existing content-session exchange, scoped to this one version.
4. The interface shows only the controls the link's permissions allow (see "Guest Review shell").
5. The first time the guest tries to comment, a dialog asks for "Your name, shown next to your comments" (required) and an email (optional, members only). That creates the `guest_principals` row. Without `comment.write` the dialog never appears, and a view-only guest has no guest record at all.
6. The guest can edit and delete only their own comments, through the existing author rule, for the life of the session. A new browser is a new guest. **my call**: there is no reclaim flow.
7. Revoking, expiring, rotating or narrowing a link ends its guest sessions on the next request. Their comments remain, rendered as "Guest · via *label* (link ended)".

Guest comments carry `author.kind = "guest"` everywhere. That includes bridge bundles, where the agent bridge sanitizes them like any other human text and labels them untrusted external input.

## Interface components

The new screens extend existing ones; the file paths are where each change lands.

| Component | Where | What it does |
| --- | --- | --- |
| **Access policy** screen | Settings, administrators only (`review/settings/`, new) | Edits the L0 policy document with a toggle or picker per setting. Each change states how many existing links or grants it narrows before saving. |
| **Members** screen | `members-screen.tsx` | Adds a "Projects" column and a member drawer listing every project and artifact grant, with links to edit each one. |
| **Project › Access** tab | `project-settings.tsx` | Access mode (Open to all members / Restricted to people listed), default member role, the member list with a role picker per row, and an add-person combobox for admitted members. Administrators appear as locked "Manager (administrator)" rows. |
| **Permission override** popover | opened from any grant row | A checklist of the eleven permissions. Each row shows its state (from role / added / removed / blocked by policy) and its source. Permissions the editor doesn't hold, or the policy ceiling forbids, are disabled with a reason. |
| **Share** popover | `share-popover.tsx` | Three sections. *People*: who has access through the project (summarized) and through artifact grants (add or remove). *Links*: every share link for this artifact with label, preset, target, expiry and guest count, plus copy, edit, rotate and revoke. *Create link*: preset (View only / View and comment / Custom), version target (This version / Latest), expiry and label. |
| **Share links** screen | replaces `public-links-screen.tsx` | The installation-wide inventory of active links, with permissions, guest count and creator columns, and bulk revoke (≤100, per-item results) as today. |
| **Why can they?** explainer | inside the Share popover and the Members drawer | Pick a person and an action, and it renders the effective-access `sources` as a plain sentence chain ("Dana can comment: Commenter on *Design*. Deleting is blocked by installation policy."). |
| **Guest Review shell** | `review-shell.tsx` in guest mode | No navigation, projects, command palette, Share, Versions, Files or Details tabs. A top banner reads "Viewing as a guest via a link shared by *creator*", with the expiry when one is set. The Comments tab appears only with `comment.read`. The Annotate switch and comment composer appear only with `comment.write`. Pages open in Interactive. The platform and theme controls stay, since they only change the preview. |
| **Guest name** dialog | guest shell | Shown on the first comment attempt: name required, email optional, a note about who can see the email. |
| **Ended link** page | `/s/*` | One readable page for expired, revoked, rotated, policy-disabled or unknown tokens. It never tells these cases apart for an unknown token. |
| Badges | comment threads, activity | A "Guest" badge plus the link label next to every guest author. Guest names never render without it. |

## Validation rules and constraints

**Granting**

1. A principal can grant, add or keep in a grant only permissions they hold on that same scope. You can't grant or add what you don't have. The service checks this on every create and update, not just in the interface.
2. Only `project.manage` holders edit project grants. Only `artifact.share` holders edit artifact grants and links. Only human administrators edit L0 and installation roles.
3. Project grants and artifact grants have no `subject_kind = guest`. Guests come only from share links.
4. A project grant's `add` and `remove` lists are disjoint, contain only known permissions, and never `add` something the role already gives or `remove` something it lacks. The service normalizes these lists so that the stored and shown values match.
5. An artifact grant's role is never `none`, and its `remove` list may not drop `artifact.view`.

**Invariants**

6. Every project, open or restricted, has at least one effective `manager`. Administrators count. A change that would leave none is refused with `LAST_MANAGER`.
7. Administrators can't be given a project grant. They're always shown as locked managers.
8. You can't lower your own access on a project through a grant edit unless someone else will still hold `project.manage` there.
9. Switching a project to `restricted` asks the actor to confirm a list of members who will lose access. The switch writes one `project_access_change` action and reports the count. It's a single transaction, so there's no window in which the project is open and half-restricted.

**Share links**

10. `permissions_json` is non-empty, contains `artifact.view`, is a subset of the guest-holdable permissions, and is a subset of L0 `guestPermissionsMax` at creation time. Every request re-checks it against the current L0.
11. `comment.write` requires `comment.read`.
12. `expires_at` is in the future and no later than `maxExpiryDays` when that is set. A pinned target must name a version of the same artifact.
13. Tokens come from the installation's random port, have at least 128 bits of entropy, are unique across the database, and never select a storage location. Rotation issues a new token and ends sessions; the link ID and its guests' comment attribution stay the same.
14. A link reaches only its version target. History, comparisons, file downloads, other artifacts, and comments anchored to other versions return `NOT_FOUND`.
15. Guest writes have their own limits: per link 60 comments an hour, per guest 20 an hour, body ≤ 8 KiB, and display name 1–60 characters with bidirectional overrides and zero-width characters stripped. Over the limit returns `429` with `Retry-After`. **my call** on the numbers.
16. A link to an archived project still serves, but `comment.write` is masked off. A deleted artifact ends the link.

**Resolution and disclosure**

17. Every application operation calls one `AccessPolicy.require(principal, permission, scope)` port. The SQLite, Postgres and D1 adapters supply grants. Product logic doesn't depend on storage (AGENTS.md).
18. A denied read of something the principal can't see returns `NOT_FOUND`. `FORBIDDEN` is used only where the principal can already see the object, for example a viewer trying to publish.
19. Deactivating a member deletes nothing. Their grants stop matching because the principal is refused, and reactivation restores them unchanged.

## Migration

- Every project becomes `open` with `default_member_role = editor`. Member access is unchanged.
- Every `access_setting = public_link` artifact gets one `share_links` row with `legacy_public_link = 1`, `token =` the existing public ID, `target = latest`, `permissions = ["artifact.view"]`, `review_controls = 0`, and no expiry. Existing URLs keep serving the same bare content with the same CDN behavior.
- API keys get `project_ids_json = '[]'`, meaning all projects. No key changes access.
- The `public_link_enable` and `public_link_disable` action history is kept as it is.
- Superseded contracts: `SCP-008` (no per-project ACL) and the parts of `CMT-006` and `CMT-013` that rule out comments through a link. Both need a new ADR, "Layered project permissions and guest review" (0033), and updates to the product spec's "Access and mutation policy" table.

## Proposed conformance requirements

| ID | Behavior | Hostile case |
| --- | --- | --- |
| PRM-001 | Upgrading an installation preserves every member's, key's and public link's effective access. | A migrated legacy link gains Review controls or comments. |
| PRM-002 | A restricted project is invisible to members without a grant in lists, search, activity, MCP and direct IDs. | A direct artifact or version ID returns anything but `NOT_FOUND`. |
| PRM-003 | Resolution follows the documented order: a project grant replaces the default, artifact grants add, ceilings and state subtract. | An override on one grant leaks into another, or a grant beats a ceiling. |
| PRM-004 | No one grants a permission they don't hold. | A crafted API request bypassing the interface succeeds. |
| PRM-005 | Every project keeps at least one effective manager. | A concurrent pair of demotions leaves zero. |
| PRM-006 | A comment-enabled link lets a guest read and write comments on its target only. | A guest reads history, another version's comments, or another artifact. |
| PRM-007 | Revoking, rotating, expiring or narrowing a link, or narrowing L0, ends guest access on the next request. | A cached guest session keeps writing. |
| PRM-008 | Guest authorship is always labeled, sanitized and rate-limited, and is marked untrusted in bridge bundles. | A guest name impersonating a member renders without the Guest badge. |
| PRM-009 | Project-scoped keys and agent connections never exceed their scope or their owner's access. | A key scoped to project A publishes to project B. |
| PRM-010 | The interface shows only controls the effective permissions allow, and explains why. | A hidden control's endpoint still accepts the call. |

## Left to the builder

- Endpoint names and paths beyond `/s/<token>` and `POST /api/share/session`.
- Caching effective permissions within one request, as long as nothing is reused across requests beyond the existing authentication-cache window.
- Visual design of the new screens, which should follow the existing Settings and Share popover patterns.
- Whether `access_grants` gets its own repository port or extends the identity repository.

## Adjustments during planning

Recorded 2026-10-26 while writing `docs/superpowers/plans/2026-10-26-permissions-model.md`. Each follows from reading the code and overrides the text above where they conflict.

1. **Roles shift one step.** Today's member cannot moderate other people's comments or rename and archive projects. `editor` therefore holds `artifact.delete` and `artifact.share`, `manager` adds `comment.moderate` and `project.manage`, and the upgrade default is `editor`.
2. **The last-manager rule is structural.** Administrators are managers everywhere, and the installation already refuses to lose its last active administrator. Rules 6 and 8 need no code, and PRM-005 becomes "administrators are always managers, can't receive grants, and can't be blocked".
3. **Legacy public links stay as they are.** The bare public link is the artifact-ID URL with no token of its own. `artifacts.access_setting` stays authoritative for it, share links are separate rows that always open Review, and there is no data migration. `legacy_public_link` and `review_controls` are dropped, and making an artifact private also revokes its share links.
4. **Grant subjects are members only.** `access_grants.subject_kind` becomes `member_id`. Keys are limited by project scope, not grants.
5. **Keys keep their capability rules.** A service or member-bound key passes only when its existing capability rule, its project scope and, for a member-bound key, the member's effective permissions all allow the operation.
6. **Guest records are created at session start.** `guest_principals.display_name` is null until the first comment, because a content session needs a principal ID.
7. **Rotation ends guests by generation.** A link has a `generation` counter, and each guest stores the generation it joined under.
8. **Guest bundles carry a body marker.** Bundle items have no author field, and the native bridge renderer is pinned, so guest item bodies start with a fixed server-generated marker.
9. **Activity ignores artifact-only grants.** A member who sees only some artifacts of a project sees no activity feed for that project.
