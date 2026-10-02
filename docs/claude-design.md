# Claude Design exports

Publish a complete Claude Design System or Claude Design Project directory with the normal CLI. Keep its styles, scripts, fonts, images, and support files together:

```sh
artifactserver publish /path/to/design-system --name "Design system"
artifactserver publish /path/to/design-project --name "Design project"
```

When there is no root `index.html` and no explicit `--entry`, Artifact Server recognizes `_ds_manifest.json` at the directory root or under `project/`. It publishes a [preview index](#preview-index-and-review-gallery) of the manifest's cards, grouped by their card groups, with templates listed separately, and opens the version on its first preview. Review shows that index as a native gallery. No catalog page is generated; every preview runs from its original path.

For projects without a design-system manifest, `.dc.html` files become an artboard gallery. A single published file continues to open directly. Publish its containing directory when it depends on sibling assets.

Portable design systems such as ArkCase can also publish without `_ds_manifest.json`.
When no vendor manifest exists, the CLI discovers `*.card.html` previews throughout
the published directory and reads their leading `@dsCard` comments:

```html
<!-- @dsCard group="Components" viewport="1100x460" name="Data Grid" subtitle="Sort, select and filter" -->
```

The generated gallery uses the source folder name as its title and
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

Every automatically detected design publication carries
`artifact-server-previews/index.json`, a versioned preview index (`"format": "artifact-server.preview-index"`; this CLI
writes `"version": 2`, and Review also reads version 1). Each item records its
`kind` (`prototype`, `template`, `component`, `guideline`, `documentation` or
`artboard`), `section`, `title`, `description`, exact published `path`, declared
`viewport`, an optional `thumbnail` (`{path, mediaType}` or `null`) and `related`
documents (`[{title, path}]`). The index also carries a title, description and
optional `cover`. Derived indexes use the vendor manifest (cards are components,
its templates are templates), card annotations (components) or bare artboards
(artboards). The version's entry is the index's first preview, so the plain
version URL opens that page outside Review.

A producer can declare its gallery precisely with `artifactserver.previews.json`
at the publication root:

```json
{
  "format": "artifact-server.preview-source",
  "version": 2,
  "title": "Workers' Compensation",
  "description": "Examiner app, claimant portal and design studies.",
  "cover": "project/.thumbnail",
  "items": [
    {"kind": "prototype", "section": "Prototypes", "title": "App",
     "path": "project/App.dc.html", "viewport": {"width": 1440, "height": 900},
     "thumbnail": "preview-thumbnails/app.webp",
     "related": [{"title": "App guide", "path": "docs/App.README.md"}]}
  ]
}
```

Version 1 sources remain accepted without `related`. The declaration outranks
`_ds_manifest.json`, card discovery and artboard detection, but never a root
`index.html` or `--entry`. Every path must name a published file; previews must
be HTML; thumbnails and the cover must be PNG, JPEG or WebP by their bytes and at
most 2 MiB; an item may link up to 24 distinct related documents. A thumbnail
whose name already has that image type is referenced in place. An extensionless
supplied image, such as a Claude export's `project/.thumbnail`, is published
again as a typed, content-addressed copy under
`artifact-server-previews/thumbnails/`; the original keeps its bytes and path.
Unknown versions or fields, duplicate previews or links, control characters,
viewports outside 1–4096, unsafe, missing, non-image, misnamed or oversized
references, and existing `artifact-server-previews/` paths fail before an upload
is created. Without a declaration, a supplied Claude `.thumbnail` becomes the
cover only when it is a supported image. Artifact Server never renders artifact
code to make thumbnails: producers capture them (the ArkCase Design repository
uses `npm run build:thumbnails`, with per-item render provenance).

Review opens a version with an index on a native gallery: grouped thumbnail tiles, search, a kind filter and a compact list,
where each item also links its related guides. Choosing a tile or guide opens
that file as the exact selected artifact, version and path, so browser history,
Share, comments and Annotate mode refer to that document. Claude Design artboards
open in the Interactive preview because their runtime loads React at run time;
Annotate stays one click away. Text files, such as Markdown guides, render as
plain text up to 1 MiB. While a gallery page is open, **Gallery** in the toolbar
(or **Back to gallery** in full-screen controls) and browser Back restore the
search, kind, layout, scroll position and the tile you left from. The index and
thumbnails load only through the exact version's authorized version-file and
media routes and are treated as untrusted data; missing or unusable thumbnails
and links degrade to placeholders or are omitted. An index Review cannot use falls
back to the version's entry page with a notice. Versions without an index,
including root `index.html` and explicit-entry publications, keep their own first
page.

Earlier CLIs also generated an `artifact-server-design.html` catalog page and made
it the entry. Those versions are immutable and keep it: Review still shows their
gallery when they carry an index, falls back to that catalog otherwise, and the
page opens with `path=artifact-server-design.html`. The name is no longer
reserved, so a source file with that name publishes as an ordinary file.

## Library

**Library** in the Review navigation (`/review/library`) gathers every readable
gallery across all projects into a single searchable view. Its toolbar groups,
sorts, and filters it by project and by kind. It is a moving view, not a frozen collection: it reads
each artifact's current version when it loads, tiles open that exact version, and
**Refresh** re-reads current versions. Galleries that cannot be read are named
and omitted. Frozen, shareable collections that pin a complete version set
remain future work (T24).

A root `index.html` takes precedence. Use `--entry path/to/page.html` to open a particular card, artboard, or template instead. Explicit entries also bypass automatic detection.

The preview index and any typed thumbnail copies are the only generated files in the immutable publication. Original files retain their bytes and paths; source directories are never modified. Stable inputs produce the same index and retry identity. Manifests larger than 4 MiB, malformed metadata, missing or unsafe preview references, empty galleries, and existing `artifact-server-previews/` paths fail before an upload is created. Existing path, symlink, publication-size, and file-count limits still apply.

This supports exported browser previews and their supplied runtimes. It does not compile JSX, reconstruct missing export files, or implement Claude Design's editor. Fonts are served with their font media types. Dependencies on remote CDNs still require network access. An existing published version remains unchanged; publish a new version to change its gallery.

The recognized layouts are observed export conventions, not a promised stable
vendor export API. Keep representative exports as compatibility fixtures when
updating detection. Published bytes do not freeze assets loaded from external
URLs, and the server does not silently vendor missing dependencies.

Producer-side thumbnail capture lives in the publishing repository; frozen
collections remain in [T19](../NEXT-STEPS.md) and T24. They must
preserve entry precedence and source bytes; changes to generated index content
apply to new publications. A project overview that follows current versions is
a moving view, not an immutable multi-artifact snapshot.

## Activity, Projects and Administration

The Activity feed, Projects screen and Admin console follow the ArkCase Artifacts
prototype at Design `e087280` (`arkcase-artifacts/project/App.dc.html`,
`workspace/projects/arkcase-artifacts/`). The vendored activity model and feed
come through `scripts/sync-arkcase-ds.mjs`; the server supplies every entry from
the action log (`GET /api/v1/activity`, `GET /api/v1/activity/summary`).

Where the prototype shows something the server cannot back, the control is
omitted rather than shown disabled:

- Project "Publishing defaults" and "Access and membership" panels — no project
  defaults or project membership exist; projects use installation membership.
- The MCP tool-group table — MCP tools are registered at runtime and no endpoint
  lists them. The WebMCP tool names are shown because the browser registers them.
- Public-link view counts and expiry, member role changes, a member's recent
  activity list, and the expiring-soon key pill.
- Web upload publishing — "Publish artifact" shows the `artifactserver publish`
  command.

Public links keep their accessible per-row selection, paging and partial-success
retry (ADM-005) inside the console instead of the prototype's single-row grid.
