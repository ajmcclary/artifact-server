/* The permissions model Artifact Server shipped on 10/26/2026, as a pure model for the prototype:
   eleven permission atoms, five ordered roles, the five access layers and their resolution, the
   override checklist, share-link presets and status, the access policy's narrowing counts and the
   "Why can they?" sentence. It follows `src/core/permissions.ts` and
   `apps/web/src/review/settings/project-access-model.ts` in the ArkCase Artifact Server
   repository. Nothing here reads App state or a live server. */

/** Permission atoms in display order. */
export const PERMISSIONS = [
  'artifact.view', 'artifact.history', 'comment.read', 'comment.write', 'comment.moderate',
  'artifact.publish', 'artifact.edit', 'artifact.delete', 'artifact.share', 'agent.dispatch', 'project.manage',
];

const PERMISSION_LABELS = {
  'agent.dispatch': 'Send work to agents',
  'artifact.delete': 'Delete artifacts',
  'artifact.edit': 'Rename, tag and restore',
  'artifact.history': 'See history and comparisons',
  'artifact.publish': 'Publish versions',
  'artifact.share': 'Share and change access',
  'artifact.view': 'Open artifacts',
  'comment.moderate': 'Delete anyone’s comments',
  'comment.read': 'Read comments',
  'comment.write': 'Write comments',
  'project.manage': 'Manage the project and its access',
};
/** The plain-language name of one permission. */
export const permissionLabel = (permission) => PERMISSION_LABELS[permission] || permission;

/** Roles in ascending order; each holds every permission of the roles below it. */
export const ROLES = ['none', 'viewer', 'commenter', 'editor', 'manager'];
const ROLE_ADDS = {
  none: [],
  viewer: ['artifact.view', 'artifact.history', 'comment.read'],
  commenter: ['comment.write'],
  editor: ['artifact.publish', 'artifact.edit', 'artifact.delete', 'artifact.share', 'agent.dispatch'],
  manager: ['comment.moderate', 'project.manage'],
};
const ROLE_LABELS = { none: 'No access', viewer: 'Viewer', commenter: 'Commenter', editor: 'Editor', manager: 'Manager' };
/** The display name of one role. */
export const roleLabel = (role) => ROLE_LABELS[role] || role;
/** Every permission one role holds, in display order. */
export function rolePermissions(role) {
  const index = ROLES.indexOf(role);
  const held = new Set(ROLES.slice(0, index + 1).flatMap((r) => ROLE_ADDS[r]));
  return PERMISSIONS.filter((p) => held.has(p));
}

/** Only these three can reach a guest through a share link. */
export const GUEST_PERMISSIONS = ['artifact.view', 'comment.read', 'comment.write'];
/** Permissions that change state; an archived project removes all of them but `ARCHIVED_KEEPS`. */
export const WRITE_PERMISSIONS = PERMISSIONS.filter((p) => !['artifact.view', 'artifact.history', 'comment.read'].includes(p));
/* An archived project stays read-only for its artifacts, but exposure-reducing actions stay open
   (Artifact Server 11/22/2026, PRJ-003): revoking, rotating or narrowing a share link, making an
   artifact private, removing or narrowing a grant and restricting the project. The two authorities
   those need survive archiving; every creating or widening change is refused (`widens*`). */
export const ARCHIVED_KEEPS = ['artifact.share', 'project.manage'];

/** The installation's ceilings (L0) as a new installation starts. */
export const DEFAULT_POLICY = {
  shareLinks: { enabled: true, guestPermissionsMax: ['artifact.view', 'comment.read', 'comment.write'], maxExpiryDays: null, linkCreators: 'sharers' },
  projects: { defaultMode: 'open' },
  members: { memberCeiling: null },
};

const sorted = (values) => { const set = new Set(values); return PERMISSIONS.filter((p) => set.has(p)); };
const live = (grant, today) => !grant.expires || grant.expires > today;

/**
 * Resolves the five layers for one subject on one artifact. `subject.kind` is `administrator`,
 * `member` or `guest`; a guest carries its link's `linkPermissions`. A member's project grant
 * replaces the project's default; artifact grants add; policy ceilings and state only subtract.
 * `today` is an ISO date (`YYYY-MM-DD`); grants expire against it. Returns `{ permissions, sources }`.
 */
export function effectiveAccess({ subject, project, artifactId = null, grants = [], policy = DEFAULT_POLICY, shareLinkId, deleted = false, today = '9999-12-31' }) {
  const granted = new Set();
  const sources = [];
  const add = (perms) => perms.forEach((p) => granted.add(p));
  const removeOutside = (allowed) => {
    const removed = sorted([...granted].filter((p) => !allowed.includes(p)));
    removed.forEach((p) => granted.delete(p));
    return removed;
  };
  const grantPermissions = (g) => {
    const set = new Set(rolePermissions(g.role));
    (g.add || []).forEach((p) => set.add(p));
    (g.remove || []).forEach((p) => set.delete(p));
    return [...set];
  };
  const grantSource = (g) => ({ layer: g.artifactId ? 'artifact_grant' : 'project_grant', grantId: g.id, role: g.role, added: g.add || [], removed: g.remove || [] });
  if (subject.kind === 'administrator') {
    add(PERMISSIONS);
    sources.push({ layer: 'administrator' });
  } else if (subject.kind === 'guest') {
    const maximum = policy.shareLinks.enabled ? policy.shareLinks.guestPermissionsMax : [];
    add((subject.linkPermissions || []).filter((p) => GUEST_PERMISSIONS.includes(p) && maximum.includes(p)));
    if (shareLinkId) sources.push({ layer: 'share_link', shareLinkId });
  } else {
    const mine = grants.filter((g) => g.memberId === subject.id && g.projectId === project.id);
    const expired = [];
    const projectGrant = mine.find((g) => !g.artifactId) || null;
    if (projectGrant && live(projectGrant, today)) {
      add(grantPermissions(projectGrant));
      sources.push(grantSource(projectGrant));
    } else {
      if (projectGrant) expired.push(projectGrant);
      if ((project.access || {}).mode !== 'restricted') {
        const role = (project.access || {}).defaultRole || 'editor';
        add(rolePermissions(role));
        sources.push({ layer: 'project_default', role });
      }
    }
    mine.filter((g) => g.artifactId && g.artifactId === artifactId).forEach((g) => {
      if (!live(g, today)) { expired.push(g); return; }
      add(grantPermissions(g));
      sources.push(grantSource(g));
    });
    const ceiling = policy.members.memberCeiling;
    if (ceiling) {
      const removed = removeOutside(ceiling);
      if (removed.length) sources.push({ layer: 'policy', removed });
    }
    if (expired.length) sources.push({ layer: 'state', reason: 'expired_grant', removed: [] });
  }
  if (deleted) {
    const removed = sorted(granted);
    granted.clear();
    sources.push({ layer: 'state', reason: 'deleted', removed });
  } else if (project.archived) {
    const removed = removeOutside(PERMISSIONS.filter((p) => !WRITE_PERMISSIONS.includes(p) || ARCHIVED_KEEPS.includes(p)));
    sources.push({ layer: 'state', reason: 'archived', removed, narrowOnly: ARCHIVED_KEEPS.filter((p) => granted.has(p)) });
  }
  return { permissions: sorted(granted), sources };
}

/** The role a member effectively holds on a project before artifact grants: `administrator`,
    their project grant's role, the open project's default, or `none` on a restricted project. */
export function projectRoleOf({ member, project, grants = [] }) {
  if (member.role === 'Administrator') return 'administrator';
  const grant = grants.find((g) => g.memberId === member.id && g.projectId === project.id && !g.artifactId);
  if (grant) return grant.role;
  return (project.access || {}).mode === 'restricted' ? 'none' : ((project.access || {}).defaultRole || 'editor');
}

/**
 * The override checklist for a grant: each permission's state against the role (`from_role`,
 * `added`, `removed`, `blocked_by_policy` or `off`), and why the editor cannot change it when they
 * do not hold it or the policy forbids it.
 */
export function overrideRows(role, add, remove, actorPermissions, ceiling) {
  const fromRole = new Set(rolePermissions(role));
  const held = new Set(actorPermissions);
  return PERMISSIONS.map((permission) => {
    const blocked = !!ceiling && !ceiling.includes(permission);
    const state = blocked ? 'blocked_by_policy' : remove.includes(permission) ? 'removed'
      : fromRole.has(permission) ? 'from_role' : add.includes(permission) ? 'added' : 'off';
    const disabledReason = blocked ? 'Blocked by installation policy' : held.has(permission) ? null : 'You don’t have this permission';
    return { permission, label: permissionLabel(permission), state, disabledReason };
  });
}
/** Toggles one permission on a grant, keeping `add` and `remove` disjoint and normalized against the role. */
export function toggleOverride(role, add, remove, permission, on) {
  const fromRole = rolePermissions(role).includes(permission);
  const nextAdd = add.filter((p) => p !== permission);
  const nextRemove = remove.filter((p) => p !== permission);
  if (on && !fromRole) nextAdd.push(permission);
  if (!on && fromRole) nextRemove.push(permission);
  return { add: sorted(nextAdd), remove: sorted(nextRemove) };
}

/** The confirmation shown before restricting a project. */
export const restrictConfirmation = (losing) => losing + ' ' + (losing === 1 ? 'member' : 'members') + ' will lose access to this project.';

/* ---- Share links ---- */
/** Presets in the Create link form; Custom keeps the guest permissions the sharer picks. */
export const SHARE_PRESETS = [
  { id: 'view', label: 'View only', permissions: ['artifact.view'] },
  { id: 'comment', label: 'View and comment', permissions: ['artifact.view', 'comment.read', 'comment.write'] },
  { id: 'custom', label: 'Custom', permissions: null },
];
/** The preset whose permission set equals `permissions`, or `custom`. */
export function presetOf(permissions) {
  const key = sorted(permissions).join(',');
  const hit = SHARE_PRESETS.find((p) => p.permissions && sorted(p.permissions).join(',') === key);
  return hit ? hit.id : 'custom';
}
export const presetLabel = (permissions) => SHARE_PRESETS.find((p) => p.id === presetOf(permissions)).label;
/** `comment.write` needs `comment.read`, and `artifact.view` is always in a link. */
export function normalizeLinkPermissions(permissions) {
  const set = new Set(permissions.filter((p) => GUEST_PERMISSIONS.includes(p)));
  set.add('artifact.view');
  if (set.has('comment.write')) set.add('comment.read');
  return sorted(set);
}
/** `active`, `expired` or `revoked`; `today` is an ISO date. */
export function shareLinkStatus(link, today) {
  if (link.revokedAt) return 'revoked';
  if (link.expires && link.expires <= today) return 'expired';
  return 'active';
}
/** Expiry choices for a new link: Never, 1, 7 and 30 days; under a policy maximum, the presets
    below it and the maximum itself, and never Never. Values are day counts, or `never`. */
export function expiryOptions(maxDays) {
  const days = (n) => ({ value: String(n), label: n + (n === 1 ? ' day' : ' days'), days: n });
  if (maxDays == null) return [{ value: 'never', label: 'Never', days: null }].concat([1, 7, 30].map(days));
  return [1, 7, 30].filter((n) => n < maxDays).concat(maxDays).map(days);
}
/** "View and comment · This version (v2) · Expires in 6 days · 3 guests", as Share and Settings list a link. */
export function linkSummary(link, { today, version } = {}) {
  const target = link.target.kind === 'latest' ? 'Latest' : version ? 'This version (v' + version + ')' : 'This version';
  const status = shareLinkStatus(link, today);
  const left = link.expires ? Math.round((Date.parse(link.expires) - Date.parse(today)) / 86400000) : null;
  const expiry = status === 'revoked' ? 'Revoked' : status === 'expired' ? 'Expired' : left == null ? 'Never expires'
    : left < 1 ? 'Expires in under a day' : 'Expires in ' + left + (left === 1 ? ' day' : ' days');
  const guests = !link.guestCount ? 'No guests yet' : link.guestCount + (link.guestCount === 1 ? ' guest' : ' guests');
  return [presetLabel(link.permissions), target, expiry, guests].join(' \u00b7 ');
}

/* ---- Access policy (L0) ---- */
/**
 * How many existing share links and grants a policy change would narrow: a narrower guest maximum
 * narrows each active link that holds a permission it drops, turning links off narrows every
 * active link, and a member ceiling narrows each grant whose permissions exceed it.
 */
export function policyNarrowing(current, next, { links = [], grants = [], today = '9999-12-31' }) {
  const linkReach = (policy, link) => (policy.shareLinks.enabled ? link.permissions.filter((p) => policy.shareLinks.guestPermissionsMax.includes(p)) : []);
  const shareLinks = links.filter((l) => shareLinkStatus(l, today) === 'active' && linkReach(next, l).length < linkReach(current, l).length).length;
  const grantPerms = (g) => { const s = new Set(rolePermissions(g.role)); (g.add || []).forEach((p) => s.add(p)); (g.remove || []).forEach((p) => s.delete(p)); return [...s]; };
  const grantReach = (policy, g) => { const c = policy.members.memberCeiling; return grantPerms(g).filter((p) => !c || c.includes(p)); };
  const grantCount = grants.filter((g) => grantReach(next, g).length < grantReach(current, g).length).length;
  return { shareLinks, grants: grantCount };
}

/* ---- Why can they? ---- */
const lowerFirst = (text) => text.charAt(0).toLowerCase() + text.slice(1);
function grantingReason(source, projectName) {
  switch (source.layer) {
    case 'administrator': return 'an administrator manages every project';
    case 'project_default': return roleLabel(source.role) + ' for every member of ' + projectName;
    case 'project_grant': return roleLabel(source.role) + ' on ' + projectName;
    case 'artifact_grant': return roleLabel(source.role) + ' on this artifact';
    case 'share_link': return 'a share link';
    default: return null;
  }
}
function removingReason(source, input) {
  const removed = source.removed || [];
  if (source.layer === 'policy' && removed.includes(input.permission)) return 'blocked by installation policy';
  if (source.layer === 'state' && removed.includes(input.permission)) return source.reason === 'archived' ? input.projectName + ' is archived' : 'the artifact was deleted';
  if ((source.layer === 'project_grant' || source.layer === 'artifact_grant') && removed.includes(input.permission)) return 'removed from ' + input.subjectName + '’s grant';
  return null;
}
/** One plain sentence saying whether a person holds a permission, and the layer that decided it. */
export function explainSentence({ access, permission, projectName, subjectName }) {
  const action = lowerFirst(permissionLabel(permission));
  if (access.permissions.includes(permission)) {
    const reason = access.sources.map((s) => grantingReason(s, projectName)).find((r) => r !== null) || 'their access';
    return subjectName + ' can ' + action + ': ' + reason + '.';
  }
  const reason = access.sources.map((s) => removingReason(s, { permission, projectName, subjectName })).find((r) => r !== null) || 'no role or grant gives it';
  return subjectName + ' cannot ' + action + ': ' + reason + '.';
}
/** Every layer that contributed, as short clauses in resolution order, for the explainer's chain. */
export function sourceChain({ access, projectName, subjectName, linkLabel }) {
  return access.sources.map((s) => {
    switch (s.layer) {
      case 'administrator': return { layer: 'Installation', text: 'Administrator — manager on every project' };
      case 'project_default': return { layer: 'Project', text: roleLabel(s.role) + ' for every member of ' + projectName };
      case 'project_grant': return { layer: 'Project', text: roleLabel(s.role) + ' on ' + projectName + overridesNote(s) };
      case 'artifact_grant': return { layer: 'Artifact', text: roleLabel(s.role) + ' on this artifact' + overridesNote(s) };
      case 'share_link': return { layer: 'Link', text: 'Guest via ' + (linkLabel || 'a share link') };
      case 'policy': return { layer: 'Policy', text: 'Installation policy removes ' + s.removed.map((p) => lowerFirst(permissionLabel(p))).join(', ') };
      case 'state': return { layer: 'State', text: s.reason === 'archived' ? projectName + ' is archived, so access can only be narrowed'
        : s.reason === 'deleted' ? 'The artifact was deleted' : 'An expired grant no longer applies' };
      default: return null;
    }
  }).filter(Boolean).concat(access.sources.length ? [] : [{ layer: 'Project', text: projectName + ' is restricted and ' + subjectName + ' is not listed' }]);
}
function overridesNote(s) {
  const parts = [];
  if (s.added && s.added.length) parts.push('plus ' + s.added.map((p) => lowerFirst(permissionLabel(p))).join(', '));
  if (s.removed && s.removed.length) parts.push('without ' + s.removed.map((p) => lowerFirst(permissionLabel(p))).join(', '));
  return parts.length ? ' (' + parts.join('; ') + ')' : '';
}

/* ---- What Review shows ---- */
/**
 * The Review controls effective access allows; a control the person lacks permission for is
 * hidden, never disabled. `guest` hides navigation, Share, Versions, Files and Details entirely.
 */
export function reviewControls(permissions, { guest = false } = {}) {
  const has = (p) => permissions.includes(p);
  return {
    view: has('artifact.view'),
    comments: has('comment.read'),
    annotate: has('comment.write'),
    compose: has('comment.write'),
    resolve: has('comment.write'),
    moderate: has('comment.moderate'),
    versions: !guest && has('artifact.history'),
    files: !guest && has('artifact.history'),
    details: !guest,
    share: !guest && has('artifact.share'),
    publish: !guest && has('artifact.publish'),
    rename: !guest && has('artifact.edit'),
    makeCurrent: !guest && has('artifact.edit'),
    remove: !guest && has('artifact.delete'),
    dispatch: !guest && has('agent.dispatch'),
    manageProject: !guest && has('project.manage'),
    navigation: !guest,
  };
}


/* ---- Widening (Artifact Server 11/22/2026). On an archived project only a change that reaches no
   further than before is allowed. Dates are ISO; a null expiry is later than any date. */
const laterExpiry = (next, before) => (next == null ? before != null : before != null && next > before);
/** Whether new link settings reach more than the link does now: a permission, a later or removed
    expiry, or a different version target. */
export function widensLink(link, next) {
  if ((next.permissions || []).some((p) => !link.permissions.includes(p))) return true;
  if (laterExpiry(next.expires, link.expires)) return true;
  const target = next.target || link.target;
  if (target.kind !== link.target.kind) return true;
  return target.kind === 'pinned' && target.versionId !== link.target.versionId;
}
/** Whether a grant (role plus overrides, and expiry) gives anything the current one does not; a new grant always widens. */
export function widensGrant(current, next) {
  if (!current) return true;
  const held = (g) => { const set = new Set(rolePermissions(g.role)); (g.add || []).forEach((p) => set.add(p)); (g.remove || []).forEach((p) => set.delete(p)); return set; };
  const before = held(current);
  if ([...held(next)].some((p) => !before.has(p))) return true;
  return laterExpiry(next.expires || null, current.expires || null);
}
/** Whether a project access change opens it, or raises the role every member gets. */
export function widensProjectAccess(current, next) {
  if (next.mode !== 'open') return false;
  if (current.mode !== 'open') return true;
  const before = new Set(rolePermissions(current.defaultRole));
  return rolePermissions(next.defaultRole).some((p) => !before.has(p));
}
export const ARCHIVED_NARROW_ONLY = 'Archived projects cannot widen access; only narrowing changes are allowed.';

/* ---- Read-only conversations. Review and Activity ask the same question of the same effective
   access, so a conversation one surface shows as read-only is read-only on the other. */
/**
 * Why `access` cannot write in an artifact's conversations, as one sentence; null when it can.
 * An archived project is named first; otherwise the role that decided the person's access.
 */
export function commentLockReason({ access, projectName }) {
  if (access.permissions.includes('comment.write')) return null;
  if (access.sources.some((s) => s.layer === 'state' && s.reason === 'archived')) return projectName + ' is archived, so its conversations are read-only.';
  if (access.sources.some((s) => s.layer === 'state' && s.reason === 'deleted')) return 'This artifact was deleted, so its conversations are read-only.';
  const decided = access.sources.filter((s) => ['project_default', 'project_grant', 'artifact_grant'].includes(s.layer) && s.role).pop();
  return decided
    ? 'You have ' + roleLabel(decided.role) + ' access to ' + projectName + ': you can read these conversations but not write in them.'
    : 'Your access lets you read these conversations but not write in them.';
}
