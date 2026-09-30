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
Artboards in the same directory appear under Artboards: a `.dc.html` name alone
does not establish that a page is a reusable template. Files remain in their
original locations, so existing relative styles, scripts, fonts, and assets work
without renaming folders or creating a manifest. `ds-exports.json` remains the
design system's JavaScript export inventory; it is not a preview manifest.

Attribute values may use single or double quotes. Names and groups must be
nonempty; viewport values must be positive `widthxheight` integers with up to four
digits per dimension, clamped to 4096. Malformed, duplicate, or unterminated
annotations fail before upload. Card previews are bounded to 4 MiB each and
checked against their prepared content hashes. An existing `_ds_manifest.json`
remains authoritative and bypasses automatic card discovery.

## Preview index and Review gallery

Every generated catalog is published with `artifact-server-previews/index.json`,
a versioned preview index (`"format": "artifact-server.preview-index"`,
`"version": 1`). Each item records its `kind` (`prototype`, `template`,
`component`, `guideline`, `documentation` or `artboard`), `section`, `title`,
`description`, exact published `path`, declared `viewport` and an optional
`thumbnail` (`{path, mediaType}` or `null`). The index also carries a title,
description and optional `cover`. Derived indexes use the vendor manifest
(cards are components, its templates are templates), card annotations
(components) or bare artboards (artboards).

A producer can declare its gallery precisely with `artifactserver.previews.json`
at the publication root:

```json
{
  "format": "artifact-server.preview-source",
  "version": 1,
  "title": "Workers' Compensation",
  "description": "Examiner app, claimant portal and design studies.",
  "cover": "project/.thumbnail",
  "items": [
    {"kind": "prototype", "section": "Prototypes", "title": "App",
     "path": "project/App.dc.html", "viewport": {"width": 1440, "height": 900},
     "thumbnail": "project/thumbnails/app.png"}
  ]
}
```

That declaration outranks `_ds_manifest.json`, card discovery and artboard
detection, but never a root `index.html` or `--entry`. Every path must name a
published file; previews must be HTML; thumbnails and the cover must be PNG,
JPEG or WebP by their bytes and at most 2 MiB. A thumbnail whose name already
has that image type is referenced in place. An extensionless supplied image,
such as a Claude export's `project/.thumbnail`, is published again as a typed,
content-addressed copy under `artifact-server-previews/thumbnails/`; the
original file keeps its bytes and path. Unknown versions or fields, duplicate
previews, control characters, viewports outside 1–4096, unsafe, missing,
non-image, misnamed or oversized references, and existing
`artifact-server-previews/` paths fail before an upload is created. Without a
declaration, a supplied Claude `.thumbnail` becomes the cover only when it is a
supported image. Artifact Server never renders artifact code to make
thumbnails.

Review opens such a version on a native gallery instead of the catalog's nested
preview stage: grouped thumbnail tiles, search, a kind filter and a compact list.
Choosing a tile opens the original file as the exact selected artifact, version
and path, so browser history, Share, comments and Annotate mode refer to that
document. **Back to gallery** and browser Back restore the search, kind, layout,
scroll position and the tile you left from. The index and thumbnails load only
through the exact version's authorized version-file and media routes and are
treated as untrusted data; missing or unusable thumbnails draw placeholders at
the declared viewport's proportions. An index Review cannot use falls back to
the original catalog with a notice. Versions published before indexes existed,
and publications with explicit entries, keep their original first page. The
generated catalog is still an ordinary file: open it with
`path=artifact-server-design.html`.

A root `index.html` takes precedence. Use `--entry path/to/page.html` to open a particular card, artboard, existing catalog, or template instead. Explicit entries also bypass automatic detection.

The generated catalog is an additional file in the immutable publication. Original files retain their bytes and paths; source directories are never modified. Stable inputs produce the same catalog and retry identity. Manifests larger than 4 MiB, malformed metadata, missing or unsafe preview references, empty catalogs, and generated filename collisions fail before an upload is created. Existing path, symlink, publication-size, and file-count limits still apply.

This supports exported browser previews and their supplied runtimes. It does not compile JSX, reconstruct missing export files, or implement Claude Design's editor. Fonts are served with their font media types. Dependencies on remote CDNs still require network access. An existing published version remains unchanged; publish a new version to add the catalog. Review annotations inside a catalog's nested frame are not a new annotation mode: select the original HTML file in Review to annotate that document directly.

The recognized layouts are observed export conventions, not a promised stable
vendor export API. Keep representative exports as compatibility fixtures when
updating detection. Published bytes do not freeze assets loaded from external
URLs, and the server does not silently vendor missing dependencies.

Automatic thumbnail generation and a cross-project design library remain in
[T19](../NEXT-STEPS.md). They must
preserve entry precedence and source bytes; changes to generated catalog content
apply to new publications. A project overview that follows current versions is
a moving view, not an immutable multi-artifact snapshot.
