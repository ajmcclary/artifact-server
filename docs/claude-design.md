# Claude Design exports

Publish a complete Claude Design System or Claude Design Project directory with the normal CLI. Keep its styles, scripts, fonts, images, and support files together:

```sh
artifactserver publish /path/to/design-system --name "Design system"
artifactserver publish /path/to/design-project --name "Design project"
```

When there is no root `index.html` and no explicit `--entry`, Artifact Server recognizes `_ds_manifest.json` at the directory root or under `project/`. It creates `artifact-server-design.html`, a searchable catalog grouped by the manifest's card groups, with templates listed separately. Each preview runs from its original path at its declared viewport size; larger previews scroll within the stage. Only the selected preview loads. “Open full preview” opens that document in the current frame. The catalog's heading identifies the export as a Claude Design System.

For projects without a design-system manifest, `.dc.html` files become an artboard catalog identified as a Claude Design Project. A single published file continues to open directly. Publish its containing directory when it depends on sibling assets.

Portable design systems such as ArkCase can also publish without `_ds_manifest.json`.
When no vendor manifest exists, the CLI discovers `*.card.html` previews throughout
the published directory and reads their leading `@dsCard` comments:

```html
<!-- @dsCard group="Components" viewport="1100x460" name="Data Grid" subtitle="Sort, select and filter" -->
```

The generated Design System catalog uses the source folder name as its title and
preserves each card's name, group, subtitle, and viewport. Cards without an
annotation use their filename, the Components group, and a 1100 × 700 viewport.
Artboards in the same directory appear under Templates. Files remain in their
original locations, so existing relative styles, scripts, fonts, and assets work
without renaming folders or creating a manifest. `ds-exports.json` remains the
design system's JavaScript export inventory; it is not a preview manifest.

Attribute values may use single or double quotes. Names and groups must be
nonempty; viewport values must be positive `widthxheight` integers with up to four
digits per dimension, clamped to 4096. Malformed, duplicate, or unterminated
annotations fail before upload. Card previews are bounded to 4 MiB each and
checked against their prepared content hashes. An existing `_ds_manifest.json`
remains authoritative and bypasses automatic card discovery.

A root `index.html` takes precedence. Use `--entry path/to/page.html` to open a particular card, artboard, existing catalog, or template instead. Explicit entries also bypass automatic detection.

The generated catalog is an additional file in the immutable publication. Original files retain their bytes and paths; source directories are never modified. Stable inputs produce the same catalog and retry identity. Manifests larger than 4 MiB, malformed metadata, missing or unsafe preview references, empty catalogs, and generated filename collisions fail before an upload is created. Existing path, symlink, publication-size, and file-count limits still apply.

This supports exported browser previews and their supplied runtimes. It does not compile JSX, reconstruct missing export files, or implement Claude Design's editor. Fonts are served with their font media types. Dependencies on remote CDNs still require network access. An existing published version remains unchanged; publish a new version to add the catalog. Review annotations inside a catalog's nested frame are not a new annotation mode: select the original HTML file in Review to annotate that document directly.

The recognized layouts are observed export conventions, not a promised stable
vendor export API. Keep representative exports as compatibility fixtures when
updating detection. Published bytes do not freeze assets loaded from external
URLs, and the server does not silently vendor missing dependencies.

Catalog navigation, exact-file annotation handoff, supplied thumbnails, and
template metadata improvements are tracked in [T19](../NEXT-STEPS.md). They must
preserve entry precedence and source bytes; changes to generated catalog content
apply to new publications. A project overview that follows current versions is
a moving view, not an immutable multi-artifact snapshot.
