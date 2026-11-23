import type {UserDelegationKey} from "@azure/storage-blob";
import {describe, expect, test} from "vitest";

import {
  createUserDelegationCopySourceUrlResolver,
  type UserDelegationKeySource,
} from "../../src/storage/azure-blob-object-storage.js";

const accountUrl = "https://artifactaccount.blob.core.windows.net";
const source = {
  containerName: "artifacts",
  name: "installations/one/staging/upl_1/token",
  url: `${accountUrl}/artifacts/installations/one/staging/upl_1/token`,
};
const minute = 60 * 1000;

/** A delegation-key source that records each issued key, as Azure would return it. */
class RecordingKeySource implements UserDelegationKeySource {
  readonly issued: {readonly expiresOn: Date; readonly startsOn: Date}[] = [];

  async getUserDelegationKey(startsOn: Date, expiresOn: Date): Promise<UserDelegationKey> {
    this.issued.push({expiresOn, startsOn});
    return {
      signedExpiresOn: expiresOn,
      signedObjectId: "00000000-0000-0000-0000-000000000001",
      signedService: "b",
      signedStartsOn: startsOn,
      signedTenantId: "00000000-0000-0000-0000-000000000002",
      signedVersion: "2020-02-10",
      value: Buffer.from("copy-source-delegation-key-bytes").toString("base64"),
    };
  }
}

function sasWindow(url: string) {
  const query = new URL(url).searchParams;
  const read = (name: string): number => {
    const value = query.get(name);
    if (value === null) throw new Error(`The SAS has no ${name} parameter.`);
    return Date.parse(value);
  };
  return {
    expiresOn: read("se"),
    keyExpiresOn: read("ske"),
    startsOn: read("st"),
  };
}

describe("Azure copy-source SAS window", () => {
  test("PUB-018 regression: a SAS signed by a cached delegation key never outlives that key and tolerates clock skew", async () => {
    const issuedAt = Date.parse("2026-11-22T12:00:00.000Z");
    let now = issuedAt;
    const keys = new RecordingKeySource();
    const resolve = createUserDelegationCopySourceUrlResolver(keys, accountUrl, () => now);

    const fresh = sasWindow(await resolve(source));
    expect(keys.issued).toHaveLength(1);
    expect(fresh.startsOn).toBe(issuedAt - 5 * minute);
    expect(fresh.expiresOn).toBe(issuedAt + 60 * minute);
    expect(fresh.expiresOn).toBeLessThanOrEqual(fresh.keyExpiresOn);

    // Fifty minutes later the cached key is still reused, so the SAS must
    // stop at the key's own expiry rather than run a full hour past now.
    now = issuedAt + 50 * minute;
    const late = sasWindow(await resolve(source));
    expect(keys.issued).toHaveLength(1);
    expect(late.startsOn).toBe(now - 5 * minute);
    expect(late.expiresOn).toBe(late.keyExpiresOn);
    expect(late.expiresOn).toBe(issuedAt + 60 * minute);

    // Inside the refresh margin a new key is issued and the full hour returns.
    now = issuedAt + 56 * minute;
    const refreshed = sasWindow(await resolve(source));
    expect(keys.issued).toHaveLength(2);
    expect(refreshed.expiresOn).toBe(now + 60 * minute);
    expect(refreshed.expiresOn).toBeLessThanOrEqual(refreshed.keyExpiresOn);
  });
});
