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
  mediaType: /\.html?$/i.test(path) ? 'text/html; charset=utf-8'
    : path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : 'application/json' });

export function fixtureManifest(artifact, number, fixture = 'Standard') {
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
