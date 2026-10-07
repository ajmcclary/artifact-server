# Hosted DSN-011 delivery and a Forms-driven hosted run

Written 2026-10-07. Nothing here has run against artifacts.backend.app. Each hosted step needs the owner's approval, and the first part is an owner decision.

## 1. What DSN-011 hosted proof needs

DSN-011-B claims that a bundle for a comment in a designed scenario carries the same location line in the native render and in the mailbox render, byte for byte. Local tests prove it. On the hosted install, nothing has delivered a bundle yet.

Facts the decision rests on:

- **The MCP mailbox key comes from the principal.** `mailboxConnectionKey(principal.id)` is the mailbox's connection key, and agents upsert on `(installation, principal, connection key)`. A second mailbox under the operator's key would therefore replace the operator's own mailbox and rename it.
- **A native bridge registers under its own connection key.** That key is `sha256(hostname, working directory)` (`connectionKeyFor` in `@plannotator/agent-bridge`). A bridge run under the operator's key adds a second agent row and leaves the mailbox alone.
- **Registering an agent needs a service principal with `agent:connect`** (`requireAgentConnection`).
- **Sending a dispatch needs a human principal or `artifact:manage:any`** (`requireDispatchSend`). The suite's operator key must still be checked against this.
- **Only a human administrator can create an API key.** In practice that means the browser admin console on artifacts.backend.app.

### Option A: a dedicated agent principal (recommended)

What the owner does once:

- Create a service API key that is not bound to a member, for example `hosted-qualification-agent`.
- Grant it `agent:connect` and `artifact:read` only, and give it an expiry.
- Store it outside the repository as a second CLI profile directory. The suite would read that directory through a new variable, such as `ARTIFACT_SERVER_HOSTED_AGENT_PROFILE_DATA`, the same way `hostedConnection()` reads the operator's profile today.

What the suite does on each run:

1. Publish the disposable artifact and make the DSN-009 region comment, as it does now.
2. Under the agent key, register an MCP mailbox and a native-bridge agent. The native agent uses the extracted bridge core with a scratch working directory, so it gets its own connection key.
3. With the operator key, send one dispatch of the comment to each agent.
4. Claim the mailbox dispatch over MCP, which gives the server's render. Claim the native dispatch through the bridge core, which gives the patched package's render.
5. Assert both renders carry the same location line. Report both dispatches `delivered`.
6. Disconnect both agents and delete the artifact.

What it proves: the whole DSN-011-B claim on hosted, repeatably, without touching the operator's mailbox.

What it costs:

- One more long-lived credential to rotate and revoke.
- Two agents visible in the installation's agent list while a run lasts.
- Dispatch and activity records that outlive the deleted artifact, since audit records are immutable.

### Option B: a live native bridge under the operator's key

What runs: the patched bridge, headless or through the Claude Code channel in a PTY like `tests/claude-live`, using the operator's key from a scratch working directory. It claims a dispatch of a hosted Forms comment.

What it proves: the native render of a hosted comment, end to end. No new credential is needed.

What it leaves open:

- The mailbox half stays local-only. Rendering it on hosted means claiming from the operator's real mailbox, which this plan does not do. "Byte for byte on hosted" is therefore not proved.
- A Claude Code channel run inside the owner's own session would touch that session.

**Recommendation: Option A.** Only Option A proves DSN-011-B as written on hosted. Option B is a smaller step, and its evidence would have to be recorded as native-only.

## 2. Driving Design's Forms adapter in the hosted suite

**Goal.** Run DSN-008-B and DSN-009-B against Design's real `support.js` and Forms runtime, not the fixture adapter. The suite still never writes to the real Forms artifact.

### Approach: copy a pinned Forms version into the suite's disposable artifact

1. **Pin the source.** The pin is a constant in the spec, for example `art_743d037f-dba7-4051-ad8f-4eda916a9661` at Forms v15's version ID. It never tracks "current", so a Design republish cannot silently change what the suite tests. Re-pinning is a deliberate one-line change.
2. **Copy.** Read the version's manifest (`GET /api/v1/artifacts/:id/versions/:versionId`). Fetch each file (`/file?path=`) or the `/archive`, and check each file's SHA-256 against the manifest. Then stage and commit the bytes as `Hosted qualification · Forms <runTag>`. The views document and provenance record come along byte for byte. The copy should therefore read `valid` and `verified`, which also gives DSN-007-B and DSN-010-B evidence on real Design output.
3. **Expectations.** Derive the view ID, scenario list and labels from the copied views document. Hard-code only a small Forms table: scenario `5` shows the Validation inspector, and region `inspector.validation.min-length` is labelled "Minimum length". Check the table against the views document first, and fail with "re-pin Forms" if the table no longer matches.
4. **Tests on the copy:**
   - DSN-008-B: the picker, a `scenario=` link, and an in-page ScenarioBar change.
   - DSN-009-B: a region comment, then reopening it in its scenario.
   - Rapid picker changes produce no "Couldn't open" status. This checks that the adapter now sends `superseded`.
   - A cold browser context still gets its hello. This exercises the load-anchored window with the real React bundle.
   - The console has no CSP violation, including the old `about:srcdoc` fetch.
   - Once Design ships it and the server is deployed: a capture in high contrast stores `view.state.theme: "high-contrast"`. How a reviewer switches Forms to high contrast still needs to be confirmed with Design.
5. **What stays on the fixture.** The hostile DSN-008-F and DSN-009-F cases (no adapter, silent, liar, overlapping), because a real adapter cannot be made to misbehave.
6. **Engines.** Design's manual checks run in Safari, so add a `webkit` project to `playwright.hosted.config.ts` for the Forms tests only.
7. **Cleanup.** Delete the copy and its comments, as the fixture run does now.

**Costs and risks.**

- The publish is larger (React and the Forms bundle), and runs take longer.
- Reading Design's artifact needs only the operator's existing read access. No new credential is needed.
- If DSN-011 Option A lands first, the DSN-011 dispatch can use the Forms comment instead of the fixture's, which proves "a hosted Forms comment" exactly as the proof gap words it.
