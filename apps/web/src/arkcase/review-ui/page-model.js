// Browser-local compatibility fixtures. Example URLs and digests are not publication evidence.
export const exampleOrigin = 'https://artifacts.example.invalid';
export const catalogPath = 'artifact-server-design.html';
const digest = '0'.repeat(64);

export function safePagePath(path) {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/')
    && !/[\\\u0000-\u001f\u007f]/.test(path)
    && !path.split('/').some((part) => !part || part === '.' || part === '..');
}

const entry = (path, size = 1024) => ({ path, size, sha256: digest, disposition: 'inline',
  mediaType: /\.html?$/i.test(path) ? 'text/html; charset=utf-8' : path.endsWith('.md') ? 'text/markdown; charset=utf-8'
    : path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : 'application/json' });

export function fixtureManifest(artifact, number, fixture = 'Standard') {
  // Design publications carry their own inventory whatever example inventory is chosen.
  if (artifact.gallery && galleryFixtures[artifact.gallery]) return galleryManifest(galleryFixtures[artifact.gallery], number);
  const multi = artifact.id === 'art_01JQ7F8C4WQ';
  let entries = [entry('index.html', multi ? 82400 : 4200)];
  let designMetadata;
  if (multi) entries.push(entry('docking.css', 11900), entry('assets/inspector.svg', 6200),
    entry('assets/board-grid.svg', 4800), entry('assets/stage-bar.svg', 3100), entry('manifest.json', 1400),
    entry('project/Review.dc.html'), entry('project/Receipt.dc.html'), entry('project/Details.dc.html'));
  if (fixture === 'Many artboards') {
    entries = [entry(catalogPath), ...Array.from({ length: 125 }, (_, i) =>
      entry(`project/${i < 65 ? 'Claims' : 'Records'}/Board ${String(i + 1).padStart(3, '0')}.dc.html`))];
  } else if (fixture === 'Design system') {
    entries = [entry(catalogPath), entry('project/_ds_manifest.json'), entry('project/components/Button.html'),
      entry('project/components/Input.html'), entry('project/templates/Case review.html'), entry('project/Other.html')];
    designMetadata = { namespace: 'ArkCase', cards: [
      { path: 'components/Button.html', name: 'Button', group: 'Actions', subtitle: 'Primary and secondary actions' },
      { path: 'components/Input.html', name: 'Input', group: 'Forms', subtitle: 'Labelled fields' },
    ], templates: [{ entryPath: 'templates/Case review.html', name: 'Case review', description: 'A complete record workspace' }] };
  } else if (fixture === 'Missing dependencies') {
    entries = [entry('index.html'), entry('project/Unavailable.dc.html')];
  } else if (fixture === 'Single page') entries = [entry('index.html', 4200)];
  // The newest fixture includes a page that is absent from its predecessor.
  if (multi && fixture === 'Standard' && number < 7) entries = entries.filter((item) => item.path !== 'project/Details.dc.html');
  return { digest, entryPath: entries[0].path, routingMode: 'static', entries,
    designMetadata, designManifestPath: designMetadata ? 'project/_ds_manifest.json' : undefined };
}

export function pageInventory(manifest) {
  const html = manifest.entries.filter((item) => safePagePath(item.path) && item.disposition === 'inline'
    && item.mediaType.split(';')[0].trim().toLowerCase() === 'text/html');
  const known = new Map();
  const metadata = manifest.designMetadata;
  const prefix = (manifest.designManifestPath || '').replace(/_ds_manifest\.json$/, '');
  const add = (path, name, group, description) => {
    if (!safePagePath(path) || typeof name !== 'string') return;
    const full = prefix + path;
    if (html.some((item) => item.path === full) && !known.has(full)) known.set(full,
      { name, group: typeof group === 'string' ? group : 'Components', description: typeof description === 'string' ? description : '' });
  };
  if (metadata && typeof metadata.namespace === 'string') {
    if (Array.isArray(metadata.cards)) metadata.cards.forEach((card) => {
      if (card && typeof card === 'object') add(card.path, card.name, card.group, card.subtitle);
    });
    if (Array.isArray(metadata.templates)) metadata.templates.forEach((template) => {
      if (template && typeof template === 'object') add(template.entryPath, template.name, 'Templates', template.description);
    });
  }
  const ordered = [...html.filter((item) => item.path === catalogPath),
    ...[...known.keys()].map((path) => html.find((item) => item.path === path)).filter((item) => item.path !== catalogPath),
    ...html.filter((item) => !known.has(item.path) && item.path !== catalogPath)];
  return ordered.map((item) => {
    const catalog = item.path === catalogPath;
    const artboard = item.path.endsWith('.dc.html');
    return { path: item.path, name: catalog ? 'Overview' : item.path.split('/').at(-1).replace(/(?:\.dc)?\.html?$/i, ''),
      group: catalog ? 'Overview' : artboard ? item.path.split('/').slice(0, -1).join('/') || 'Artboards' : 'Other pages',
      description: '', ...known.get(item.path), isDefault: item.path === manifest.entryPath,
      unavailable: item.path.endsWith('/Unavailable.dc.html') };
  });
}

export function filterPages(pages, query = '') {
  const q = query.trim().toLocaleLowerCase();
  return pages.filter((page) => `${page.name} ${page.path} ${page.group}`.toLocaleLowerCase().includes(q));
}

export function resolveEntry(manifest, requested = '') {
  const paths = manifest.entries.map((item) => item.path);
  const selected = requested || (paths.length === 1 ? paths[0]
    : paths.includes('index.html') ? 'index.html' : paths.includes(catalogPath) ? catalogPath : null);
  if (!selected || !safePagePath(selected) || !paths.includes(selected)) throw new Error('Choose a default page that is included in this publication.');
  if (manifest.routingMode === 'spa' && !manifest.entries.some((item) => item.path === selected && item.mediaType.split(';')[0].trim() === 'text/html'))
    throw new Error('Single-page application routing requires an HTML default page.');
  return selected;
}

export function currentArtifactUrl(artifact) {
  return artifact.links?.artifact || new URL(`/artifacts/${encodeURIComponent(artifact.id)}`, exampleOrigin).toString();
}

export function exactPageUrl(snapshot, path) {
  if (!safePagePath(path) || !snapshot.manifest.entries.some((item) => item.path === path)) return null;
  return new URL(path.split('/').map(encodeURIComponent).join('/'), snapshot.links.version).toString();
}

export function reviewPageUrl(snapshot, path) {
  const url = new URL(snapshot.links.review);
  if (path != null && snapshot.manifest.entries.some((item) => item.path === path)) url.searchParams.set('path', path);
  return url.toString();
}

export function freezeSnapshot(artifact, number, manifest) {
  const token = `demo${artifact.id.replace(/[^a-z0-9]/gi, '').toLowerCase()}v${number}`;
  const id = `ver_${artifact.id.slice(4).toLowerCase()}_${String(number).padStart(2, '0')}`;
  const review = new URL('/review', exampleOrigin);
  review.search = new URLSearchParams({ project: artifact.projectId, artifact: artifact.id, version: id, view: 'focus' }).toString();
  const snapshot = { version: { id, number, artifactId: artifact.id, projectId: artifact.projectId,
    contentToken: token, createdAt: '2026-09-24T12:00:00.000Z', publisherPrincipalId: 'principal_demo',
    entryPath: manifest.entryPath, routingMode: manifest.routingMode, manifestDigest: manifest.digest },
    manifest: JSON.parse(JSON.stringify(manifest)), links: { review: review.toString(), version: `https://${token}.content.example.invalid/` } };
  const freeze = (value) => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  return freeze(snapshot);
}

export function snapshotFor(session, artifact, number, fixture = 'Standard') {
  return session.snapshots?.[artifact.id]?.[number] || freezeSnapshot(artifact, number, fixtureManifest(artifact, number, fixture));
}

export const draftScope = (artifactId, versionId, path) => JSON.stringify([artifactId, versionId, path]);

/* Design gallery. Kinds come from a publication's preview index; `.dc.html` alone does
   not make an item a template, so unclassified artboards keep their own kind. */
export const galleryKinds = [
  { id: 'prototype', label: 'Prototypes', singular: 'Prototype', icon: 'bi-window' },
  { id: 'template', label: 'Templates', singular: 'Template', icon: 'bi-columns-gap' },
  { id: 'component', label: 'Components', singular: 'Component', icon: 'bi-grid-1x2' },
  { id: 'guideline', label: 'Guidelines', singular: 'Guideline', icon: 'bi-palette' },
  { id: 'documentation', label: 'Documentation', singular: 'Document', icon: 'bi-journal-text' },
  { id: 'artboard', label: 'Artboards', singular: 'Artboard', icon: 'bi-bounding-box' },
];
export const galleryKind = (id) => galleryKinds.find((kind) => kind.id === id) || galleryKinds.at(-1);

export function filterGallery(items, query = '', kind = 'all') {
  const q = query.trim().toLocaleLowerCase();
  return items.filter((item) => (kind === 'all' || item.kind === kind)
    && `${item.title} ${item.section} ${item.description || ''} ${item.path} ${item.context || ''} ${galleryKind(item.kind).label}`
      .toLocaleLowerCase().includes(q));
}

/** Kind order is fixed; sections keep the publication's first-seen order within a kind. */
export function groupGallery(items) {
  return galleryKinds.map((kind) => {
    const inKind = items.filter((item) => item.kind === kind.id);
    const sections = [...new Set(inKind.map((item) => item.section))]
      .map((section) => ({ section, items: inKind.filter((item) => item.section === section) }));
    return { ...kind, count: inKind.length, sections };
  }).filter((group) => group.count > 0);
}

/* Preview index. A generated catalog publishes `artifact-server-previews/index.json`
   beside it; Review opens such a version on its gallery. The fixture carries the parsed
   index as `manifest.previewIndex`, a presentation input like `designMetadata`. */
export const previewIndexPath = 'artifact-server-previews/index.json';
/** Guides and other text files render as text, never as markup, up to this size. */
export const maximumTextPreviewBytes = 1024 * 1024;
const essence = (mediaType) => String(mediaType).split(';')[0].trim().toLowerCase();

/**
 * The version's gallery, read as untrusted data. `absent` when the entry is not the
 * generated catalog or no index was published (root index.html, explicit entries and
 * pre-index versions keep their first page); `invalid` falls back to the catalog.
 */
export function previewIndex(manifest) {
  if (manifest.entryPath !== catalogPath || !manifest.entries.some((item) => item.path === previewIndexPath)) return { status: 'absent' };
  const index = manifest.previewIndex;
  const invalid = (reason) => ({ status: 'invalid', reason });
  if (!index || index.format !== 'artifact-server.preview-index') return invalid('The preview index does not match format version 2.');
  if (index.version !== 1 && index.version !== 2) return invalid(`Preview index version ${index.version} is not supported by this Review.`);
  const byPath = new Map(manifest.entries.map((item) => [item.path, item]));
  const seen = new Set();
  const items = [];
  for (const item of Array.isArray(index.items) ? index.items : []) {
    const page = byPath.get(item?.path);
    if (!page || essence(page.mediaType) !== 'text/html') return invalid('The preview index names a page that is not an HTML file of this version.');
    if (!galleryKinds.some((kind) => kind.id === item.kind)) return invalid(`The preview index does not match format version ${index.version}.`);
    if (seen.has(item.path)) return invalid('The preview index lists a page more than once.');
    seen.add(item.path);
    const thumbnail = item.thumbnail && byPath.get(item.thumbnail.path);
    const links = new Set();
    items.push({ kind: item.kind, section: item.section, title: item.title, description: item.description || '',
      path: item.path, viewport: item.viewport,
      thumbnailPath: thumbnail && essence(thumbnail.mediaType) === item.thumbnail.mediaType ? thumbnail.path : null,
      // Version 1 has no related links; links to files outside this exact version are dropped.
      related: index.version === 2 && Array.isArray(item.related) ? item.related.filter((link) => {
        if (!byPath.has(link.path) || links.has(link.path)) return false;
        links.add(link.path);
        return true;
      }).map((link) => ({ title: link.title, path: link.path })) : [] });
  }
  if (!items.length) return invalid(`The preview index does not match format version ${index.version}.`);
  return { status: 'ready', title: index.title, description: index.description || '', items };
}

/** Text of a fixture file. The prototype carries a few files' contents, not every file's. */
export function fixtureText(manifest, path) {
  return manifest.texts?.[path] ?? standardTexts[path]
    ?? `This local fixture carries no contents for ${path}. A published version serves its exact bytes.`;
}

const standardTexts = {
  'docking.css': '[data-ak-panel][data-side="end"] {\n  border-left: 1px solid var(--border-color);\n}\n\n'
    + '[data-ak-panel][data-pinned="true"] {\n  flex: none;\n  width: var(--ak-panel-width, 344px);\n}\n',
};

const galleryItem = (kind, section, title, path, width, height, description, related = []) =>
  ({ kind, section, title, description, path, viewport: { width, height }, thumbnail: null,
    related: related.map(([linkTitle, linkPath]) => ({ title: linkTitle, path: linkPath })) });
const guide = (title, lead) => `# ${title}\n\n${lead}\n\nThis guide is a local fixture; a published version serves`
  + ' the producer\'s own text.\n';

/* Design publications. `since` is the first version that carried a preview index;
   earlier versions keep their original catalog as their first page. */
const galleryFixtures = {
  'design-system': {
    since: 2,
    title: 'ArkCase design system',
    description: 'Components, guidelines, templates and their guides.',
    items: [
      galleryItem('template', 'Templates', 'Case review', 'templates/Case review.dc.html', 1440, 900,
        'A complete record workspace with its inspector.', [['Templates guide', 'templates/README.md']]),
      galleryItem('template', 'Templates', 'Record list', 'templates/Record list.dc.html', 1440, 900,
        'A queue with filters and a docked record.', [['Templates guide', 'templates/README.md']]),
      galleryItem('component', 'Actions', 'Buttons', 'components/actions/Button.card.html', 1100, 460,
        'Primary, secondary and link actions.', [['Button guide', 'components/actions/Button.README.md'],
          ['IconButton guide', 'components/actions/IconButton.README.md']]),
      galleryItem('component', 'Forms', 'Input', 'components/forms/Input.card.html', 1100, 460,
        'Labelled fields with helper and error text.', [['Input guide', 'components/forms/Input.README.md']]),
      galleryItem('component', 'Data display', 'Data grid', 'components/data-display/DataGrid.card.html', 1100, 700,
        'Sort, select and filter.', [['DataGrid guide', 'components/data-display/DataGrid.README.md']]),
      galleryItem('component', 'Feedback', 'Alert', 'components/feedback/Alert.card.html', 1100, 460,
        'Messages that sit in the flow of a page.', [['Alert guide', 'components/feedback/Alert.README.md']]),
      galleryItem('guideline', 'Foundations', 'Color', 'guidelines/Color.card.html', 1100, 700, 'Semantic surface and text pairs.'),
      galleryItem('guideline', 'Foundations', 'Typography', 'guidelines/Typography.card.html', 1100, 700, 'Display, body and data faces.'),
      galleryItem('documentation', 'Guides', 'Getting started', 'docs/Getting started.html', 1100, 800,
        'Loading order and theme boot for portable pages.', [['Design system readme', 'readme.md']]),
    ],
    texts: {
      'readme.md': guide('ArkCase design system', 'Token sheets load in order: fonts, icons, colors, typography, spacing, elevation, base.'),
      'templates/README.md': guide('Templates', 'A template is a complete composition that a project copies and owns.'),
      'components/actions/Button.README.md': guide('Button', 'One primary action per region; secondary actions are outlined.'),
      'components/actions/IconButton.README.md': guide('IconButton', 'Every icon-only button carries an accessible name.'),
      'components/forms/Input.README.md': guide('Input', 'Every field has a visible label; helper text sits below it.'),
      'components/data-display/DataGrid.README.md': guide('DataGrid', 'Sorting and selection are announced; filters are named.'),
      'components/feedback/Alert.README.md': guide('Alert', 'An alert reports a message; a condition belongs in a ribbon.'),
    },
  },
  prototypes: {
    since: 1,
    title: 'Claims examiner',
    description: 'Examiner app, claimant portal and design studies.',
    items: [
      galleryItem('prototype', 'Prototypes', 'App', 'project/App.dc.html', 1440, 900,
        'The examiner workstation.', [['App guide', 'docs/App.README.md']]),
      galleryItem('prototype', 'Prototypes', 'Portal', 'project/Portal.dc.html', 390, 844,
        'The claimant portal on a phone.', [['Portal guide', 'docs/Portal.README.md']]),
      galleryItem('prototype', 'Prototypes', 'Sign in', 'project/Auth.dc.html', 1440, 900, 'Sign-in scenarios.'),
      galleryItem('artboard', 'Design studies', 'Inspector dock', 'project/studies/Inspector dock.dc.html', 1440, 900, ''),
      galleryItem('artboard', 'Design studies', 'Stage bar', 'project/studies/Stage bar.dc.html', 390, 844, ''),
      galleryItem('artboard', 'Design studies', 'Coverage ribbon', 'project/studies/Coverage ribbon.dc.html', 1280, 800, ''),
    ],
    texts: {
      'docs/App.README.md': guide('App', 'The workstation opens on the queue; a record docks its inspector at the end edge.'),
      'docs/Portal.README.md': guide('Portal', 'Hit targets hold at 44px below the tablet floor.'),
    },
  },
  // An index this Review cannot read: the version falls back to its original catalog.
  unreadable: {
    since: 1, title: 'Correspondence', description: '', version: 3,
    items: [galleryItem('template', 'Letters', 'Letter', 'project/Letter.dc.html', 816, 1056, ''),
      galleryItem('template', 'Letters', 'Memo', 'project/Memo.dc.html', 816, 1056, '')],
    texts: {},
  },
};

function galleryManifest(fixture, number) {
  const indexed = number >= fixture.since;
  const paths = [...new Set(fixture.items.flatMap((preview) => [preview.path, ...preview.related.map((link) => link.path)])
    .concat(Object.keys(fixture.texts)))];
  const entries = [entry(catalogPath), ...(indexed ? [entry(previewIndexPath, 2600)] : []), ...paths.map((path) => entry(path))];
  return { digest, entryPath: catalogPath, routingMode: 'static', entries, texts: fixture.texts,
    previewIndex: indexed ? { format: 'artifact-server.preview-index', version: fixture.version || 2, origin: 'producer',
      title: fixture.title, description: fixture.description, cover: null, items: fixture.items } : undefined };
}
