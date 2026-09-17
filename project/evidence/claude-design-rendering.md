# Claude Design local rendering evidence

Recorded 2026-09-17 using Node 24.15.0 and Chromium. Both supplied source directories were published through the staged file client into temporary local installations with account-required access, then opened through Review. The installations were removed after the checks. Source directories were read without modification.

| Export | Published files, including catalog | Catalog previews | Source manifest SHA-256 |
| --- | ---: | ---: | --- |
| ExtractionKit | 277 | 46 | `aa598ee3306d314db3e4f5f133a17c573e04cbeae3770840380b0ea5cb88567c` |
| Allegory | 3359 | 117 | `a327be71ca40ccd8ae9df06ce0b8f5e7387ab6e7978ccbc95393d1100528e888` |

Observed rendering:

- ExtractionKit: App Bar / Wordmark: original logo, styles, and icon font rendered; background color checked.
- Allegory: Keyboard / Accessory bar: original React preview and bundled component rendered.

No page JavaScript errors were recorded for those selected previews. This is sampled visual evidence, not an assertion that every exported card, template, remote CDN dependency, or native interaction works. Allegory exports repeat a keyboard key label; the preview preserves that source behavior.

The dependency-free browser test in `tests/browser/claude-design.spec.ts` separately proves nested relative CSS and scripts, component interaction, declared viewport dimensions, filtering, template navigation, private Review delivery, and opening a full preview within the existing sandbox. `claude-design-browser.json` records the final focused browser run. `claude-design.json` records the DSN-001 publication and hostile-input tests. Team deployment rendering remains unverified.

## Repository verification

`pnpm verify:iteration` completed successfully on 2026-09-17 with Node 24.15.0, including 329 correctness tests, 30 browser tests, provider and storage checks, coverage, local packaging, performance baselines, Compose, Helm recovery, and real Keycloak OIDC tests. The final focused publication and browser reports also cover the full-preview link and short declared viewports. `pnpm smoke`, final lint/type checks, conformance validation, and `git diff --check` passed. This is local verification, not production deployment qualification.
