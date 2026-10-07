import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  commitStagedUpload,
  createStagedUpload,
  type CreateUploadResponse,
  type TestSiteFile,
} from "../support/publishing.js";
import {
  browserMutationHeaders,
  createInvite,
  type InviteServer,
  redeem,
  signInAs,
  bootstrapAdministrator,
  applicationCookies,
  startInviteServer,
} from "../support/invites.js";

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

const batchResponseSchema = z.object({
  accepted: z.array(z.object({path: z.string()}).loose()),
  rejected: z.array(z.object({code: z.string()}).loose()),
}).loose();

/**
 * A batch carries no per-file capability token, so only the upload's owner
 * may send one. The owner named in the batch URL's query is not authority.
 */
describe("staged upload batch ownership", () => {
  let context: InviteServer;

  beforeEach(async () => {
    context = await startInviteServer();
  });

  afterEach(async () => {
    await context.stop();
  });

  test("a batch from a principal who does not own the upload verifies nothing and looks like a missing upload", async () => {
    const files: readonly TestSiteFile[] = [
      {bytes: utf8("owned bytes\n"), mediaType: "text/html; charset=utf-8", path: "index.html"},
    ];
    const key = "upload-batch-owner-plan-000000001";
    const planned = await createStagedUpload(context.server, context.installation, "index.html", files, undefined, "static", key);
    const frame = buildFrame(files.map((file, orderIndex) => ({bytes: file.bytes, orderIndex})));

    // Another administrator, signed in as themselves, holds every capability but not this upload.
    const administrator = await signInAs(context, bootstrapAdministrator);
    const invite = await createInvite(context, administrator, {
      email: "dana@acme.test",
      expiresIn: "7d",
      kind: "person",
      role: "administrator",
    });
    const joined = await redeem(context, invite.token, {displayName: "Dana Okonkwo", email: "dana@acme.test", subject: "dana"});
    expect(joined.status).toBe(303);
    const dana = applicationCookies(joined.headers.getSetCookie());
    const danaHeaders = browserMutationHeaders(context.server.baseUrl, dana);
    danaHeaders.set("Content-Type", "application/octet-stream");

    const foreign = await fetch(batchUrl(planned), {body: frame.slice(), headers: danaHeaders, method: "POST"});
    const missing = await fetch(batchUrl(planned, "upl_missing"), {body: frame.slice(), headers: danaHeaders, method: "POST"});
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());

    // The owner's own batch still verifies the slot, so the foreign one verified nothing.
    const resumed = await createStagedUpload(context.server, context.installation, "index.html", files, undefined, "static", key);
    expect(resumed.body.uploadId).toBe(planned.body.uploadId);
    expect(resumed.body.files.map((file) => file.verified)).toEqual([false]);
    const owned = await fetch(batchUrl(planned), {
      body: frame.slice(),
      headers: {Authorization: `Bearer ${context.installation.apiToken}`, "Content-Type": "application/octet-stream"},
      method: "POST",
    });
    expect(owned.status).toBe(200);
    expect(batchResponseSchema.parse(await owned.json()).accepted.map((part) => part.path)).toEqual(["index.html"]);
    const published = await commitStagedUpload(
      context.installation,
      planned.body,
      "upload-batch-owner",
      {accessSetting: "account_required", kind: "new_artifact", name: "Owned batch"},
    );
    expect(published.body.version.number).toBe(1);
  });

  function batchUrl(planned: {readonly body: CreateUploadResponse}, uploadId = planned.body.uploadId): URL {
    const fileUploadUrl = planned.body.files[0]?.uploadUrl;
    if (fileUploadUrl === undefined) throw new Error("The upload plan declares no file upload URL.");
    const url = new URL(`/api/v1/uploads/${uploadId}/batch`, context.server.baseUrl);
    // The issued query names the owner; a caller who copies it gains nothing.
    url.search = new URL(fileUploadUrl).search;
    return url;
  }
});

function buildFrame(parts: readonly {readonly bytes: Uint8Array; readonly orderIndex: number}[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + 12 + part.bytes.byteLength, 0);
  const frame = new Uint8Array(total);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.orderIndex, true);
    view.setFloat64(offset + 4, part.bytes.byteLength, true);
    frame.set(part.bytes, offset + 12);
    offset += 12 + part.bytes.byteLength;
  }
  return frame;
}
