# Claude Design exports

Publish a complete Claude Design System or Claude Design Project directory with the normal CLI. Keep its styles, scripts, fonts, images, and support files together:

```sh
artifactserver publish /path/to/design-system --name "Design system"
artifactserver publish /path/to/design-project --name "Design project"
```

When there is no root `index.html` and no explicit `--entry`, Artifact Server recognizes `_ds_manifest.json` at the directory root or under `project/`. It creates `artifact-server-design.html`, a searchable catalog grouped by the manifest's card groups, with templates listed separately. Each preview runs from its original path at its declared viewport size; larger previews scroll within the stage. Only the selected preview loads. “Open full preview” opens that document in the current frame. The catalog's heading identifies the export as a Claude Design System.

For projects without a design-system manifest, `.dc.html` files become an artboard catalog identified as a Claude Design Project. A single published file continues to open directly. Publish its containing directory when it depends on sibling assets.

A root `index.html` takes precedence. Use `--entry path/to/page.html` to open a particular card, artboard, existing catalog, or template instead. Explicit entries also bypass automatic detection.

The generated catalog is an additional file in the immutable publication. Original files retain their bytes and paths; source directories are never modified. Stable inputs produce the same catalog and retry identity. Manifests larger than 4 MiB, malformed metadata, missing or unsafe preview references, empty catalogs, and generated filename collisions fail before an upload is created. Existing path, symlink, publication-size, and file-count limits still apply.

This supports exported browser previews and their supplied runtimes. It does not compile JSX, reconstruct missing export files, or implement Claude Design's editor. Fonts are served with their font media types. Dependencies on remote CDNs still require network access. An existing published version remains unchanged; publish a new version to add the catalog. Review annotations inside a catalog's nested frame are not a new annotation mode: select the original HTML file in Review to annotate that document directly.
