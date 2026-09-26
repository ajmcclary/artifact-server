import { createHash, createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import * as Schema from "effect/Schema";

const PACKAGE_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, "..", "..");
const QUALIFICATION_BUCKET = "artifact-server-qual-r2-20260925";
const PROBE_DATABASE_NAME = "probe-d1-rtt-20260926";
const DEFAULT_SAMPLES = 50;
const WARMUP_CALLS = 3;
const API_BASE = "https://api.cloudflare.com/client/v4";
const CreatedDatabase = Schema.Struct({
  result: Schema.Struct({
    uuid: Schema.String.check(
      Schema.isPattern(
        /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu,
      ),
    ),
  }),
});

const usage = `Usage: node scripts/measure-api-rtt.mjs \\
  --confirm-account <account-id> [--samples <n>]

Bounded, read-mostly Cloudflare API measurement for the T08 cost envelope.
Measures isolated per-call RTT for the Cloudflare REST API, the D1 query API
(against a short-lived ${PROBE_DATABASE_NAME} database), and the R2 S3 data
plane (ListObjectsV2 against the empty ${QUALIFICATION_BUCKET} bucket). Also
observes the cheap deterministic D1 limits (bound parameters, statement
bytes, row bytes) on the probe database, records a read-only account
inventory, and deletes the probe database before exiting.`;

const fail = (message) => {
  console.error(message);
  console.error(usage);
  process.exitCode = 1;
};

const requiredEnvironment = (name) => {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} must be set in the environment.`);
  }
  return value;
};

const cloudflareHeaders = (token) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

const cloudflareFetch = async (token, path, init) => {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: cloudflareHeaders(token),
  });
  let document = null;
  try {
    document = await response.json();
  } catch {
    document = null;
  }
  return {document, status: response.status};
};

// --- Minimal S3 SigV4 signing for the R2 data-plane leg. ---

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
const hmacSha256 = (key, data) =>
  createHmac("sha256", key).update(data).digest();

const r2ListObjectsUrl = (endpoint, bucket) => {
  const url = new URL(`${endpoint.replace(/\/+$/u, "")}/${bucket}`);
  url.searchParams.set("list-type", "2");
  url.searchParams.set("max-keys", "1000");
  return url;
};

const signedR2ListRequest = (endpoint, bucket, accessId, accessKey) => {
  const url = r2ListObjectsUrl(endpoint, bucket);
  const now = new Date();
  const amzDate = now.toISOString().replaceAll(/[-:]/gu, "").replace(
    /\.\d{3}Z$/u,
    "Z",
  );
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex("");
  const canonicalQuery = [...url.searchParams.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) =>
      `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    )
    .join("&");
  const canonicalHeaders =
    `host:${url.host}\nx-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "GET",
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = [dateStamp, "auto", "s3", "aws4_request"].reduce(
    (key, part) => hmacSha256(key, part),
    `AWS4${accessKey}`,
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex");
  return {
    headers: {
      authorization:
        `AWS4-HMAC-SHA256 Credential=${accessId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
    url,
  };
};

// --- Timing helpers. ---

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });

const timedSamples = async (label, samples, call) => {
  for (let index = 0; index < WARMUP_CALLS; index += 1) {
    // Sequential sampling is the measurement; batching would hide RTT.
    // eslint-disable-next-line no-await-in-loop
    await call();
    // eslint-disable-next-line no-await-in-loop
    await sleep(50);
  }
  const milliseconds = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    // Sequential sampling is the measurement; batching would hide RTT.
    // eslint-disable-next-line no-await-in-loop
    await call();
    milliseconds.push(performance.now() - started);
    // eslint-disable-next-line no-await-in-loop
    await sleep(50);
  }
  console.log(`${label}: ${samples} samples recorded`);
  return milliseconds;
};

const summarize = (milliseconds) => {
  const sorted = milliseconds.toSorted((a, b) => a - b);
  const percentile = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    max: sorted[sorted.length - 1],
    mean: total / sorted.length,
    min: sorted[0],
    p50: percentile(0.5),
    p95: percentile(0.95),
  };
};

// --- D1 limit probes. ---

const d1Query = async (token, accountId, databaseId, sql, params) => {
  const result = await cloudflareFetch(
    token,
    `/accounts/${accountId}/d1/database/${databaseId}/query`,
    {body: JSON.stringify({params, sql}), method: "POST"},
  );
  const errors = Array.isArray(result.document?.errors)
    ? result.document.errors.map((error) => ({
      code: error.code,
      message: String(error.message).slice(0, 200),
    }))
    : [];
  const firstResult = Array.isArray(result.document?.result)
    ? result.document.result[0]
    : undefined;
  const resultErrors = Array.isArray(firstResult?.error)
    ? firstResult.error
    : firstResult?.error === undefined
    ? []
    : [String(firstResult.error).slice(0, 200)];
  return {
    errors,
    resultErrors,
    status: result.status,
    succeeded:
      result.status === 200 && result.document?.success === true &&
      errors.length === 0 && firstResult?.success !== false,
  };
};

const observeLimit = async (label, run) => {
  const outcome = await run();
  const observed = !outcome.succeeded;
  console.log(
    `${label}: ${observed ? "rejected as documented" : "NOT rejected"}` +
      ` (status ${outcome.status})`,
  );
  return {
    errors: outcome.errors,
    observed,
    resultErrors: outcome.resultErrors,
    status: outcome.status,
  };
};

const main = async () => {
  const parsed = parseArgs({
    options: {
      "confirm-account": {type: "string"},
      help: {default: false, type: "boolean"},
      samples: {default: String(DEFAULT_SAMPLES), type: "string"},
    },
    strict: true,
  });
  if (parsed.values.help) {
    console.log(usage);
    return;
  }
  const confirmAccount = parsed.values["confirm-account"];
  if (confirmAccount === undefined) {
    fail("--confirm-account is required.");
    return;
  }
  const samples = Number.parseInt(parsed.values.samples, 10);
  if (!Number.isInteger(samples) || samples < 5 || samples > 500) {
    fail("--samples must be an integer between 5 and 500.");
    return;
  }

  const startedAt = new Date().toISOString();
  const token = requiredEnvironment("CLOUDFLARE_API_TOKEN");
  const accountId = requiredEnvironment("CLOUDFLARE_ACCOUNT_ID");
  const r2Endpoint = requiredEnvironment("CLOUDFLARE_R2_ENDPOINT");
  const r2AccessId = requiredEnvironment("CLOUDFLARE_R2_ACCESS_ID");
  const r2AccessKey = requiredEnvironment("CLOUDFLARE_R2_ACCESS_KEY");
  if (accountId !== confirmAccount) {
    fail(
      "CLOUDFLARE_ACCOUNT_ID does not match --confirm-account; refusing " +
        "to touch any account.",
    );
    return;
  }

  // 1. Confirm the active account before any other call.
  const verification = await cloudflareFetch(token, "/user/tokens/verify");
  const account = await cloudflareFetch(token, `/accounts/${accountId}`);
  const accountName = account.document?.result?.name;
  if (
    verification.status !== 200 || verification.document?.success !== true ||
    account.status !== 200 || account.document?.success !== true
  ) {
    fail("Token verification or account lookup failed; aborting.");
    return;
  }
  console.log(`Confirmed account ${accountId} (${String(accountName)}).`);

  // 2. Read-only inventory: D1 databases and R2 buckets.
  const d1List = await cloudflareFetch(
    token,
    `/accounts/${accountId}/d1/database?per_page=100`,
  );
  const r2List = await cloudflareFetch(
    token,
    `/accounts/${accountId}/r2/buckets?per_page=100`,
  );
  const d1Databases = Array.isArray(d1List.document?.result)
    ? d1List.document.result.map((database) => ({
      fileSize: database.file_size ?? null,
      name: String(database.name),
      numTables: database.num_tables ?? null,
    }))
    : [];
  const r2Buckets = Array.isArray(r2List.document?.result?.buckets)
    ? r2List.document.result.buckets.map((bucket) => ({
      creationDate: bucket.creation_date ?? null,
      name: String(bucket.name),
    }))
    : [];
  console.log(
    `Inventory: ${d1Databases.length} D1 databases, ` +
      `${r2Buckets.length} R2 buckets.`,
  );

  // 3. Create the short-lived probe D1 database.
  const created = await cloudflareFetch(
    token,
    `/accounts/${accountId}/d1/database`,
    {
      body: JSON.stringify({name: PROBE_DATABASE_NAME}),
      method: "POST",
    },
  );
  if (
    created.status !== 200 || !Schema.is(CreatedDatabase)(created.document)
  ) {
    fail("Could not create the probe D1 database; aborting.");
    return;
  }
  const databaseId = created.document.result.uuid;
  console.log(`Created probe database ${PROBE_DATABASE_NAME}.`);

  const evidence = {
    accountId,
    accountName: String(accountName),
    allowanceSnapshot: {
      asOf: "2026-09-26",
      d1: "Free: 5M rows read/day, 100k rows written/day; this run reads " +
        "about 55 rows and writes about 5 rows, all deleted",
      plan: "Workers Free (dashboard observation 2026-09-23)",
      r2: "Active at $0/month base; 10 GB-month, 1M Class A, 10M Class B " +
        "allowance (dashboard observation 2026-09-23); this run lists " +
        "objects only (Class B)",
      sources: "project/performance/CLOUDFLARE-COST-ENVELOPE.md",
      workers: "100,000 requests/day Free cap; this run performs about " +
        "120 Cloudflare API requests, no Worker invocations",
    },
    cleanup: {probeDatabaseDeleted: false, probeDatabaseAbsent: false},
    finishedAt: null,
    hardLimitObservations: {},
    inventory: {d1Databases, qualificationBucket: null, r2Buckets},
    measurementContext: {
      architecture: os.arch(),
      commit: process.env.GITHUB_SHA ?? "working tree",
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      date: startedAt.slice(0, 10),
      node: process.version,
      platform: os.platform(),
    },
    probeDatabase: PROBE_DATABASE_NAME,
    qualificationBucket: QUALIFICATION_BUCKET,
    rttLegs: {},
    samplesPerLeg: samples,
    startedAt,
    success: false,
  };

  try {
    // 4. RTT legs.
    evidence.rttLegs.cloudflareRestApi = summarize(
      await timedSamples("cloudflare-rest-api", samples, async () => {
        const result = await cloudflareFetch(token, `/accounts/${accountId}`);
        if (result.status !== 200) throw new Error("REST leg failed");
      }),
    );
    evidence.rttLegs.d1QueryApi = summarize(
      await timedSamples("d1-query-api", samples, async () => {
        const result = await d1Query(
          token,
          accountId,
          databaseId,
          "SELECT 1",
          [],
        );
        if (!result.succeeded) throw new Error("D1 leg failed");
      }),
    );
    const qualificationBucketObjects = {bytes: 0, keys: []};
    evidence.rttLegs.r2S3ListObjects = summarize(
      await timedSamples("r2-s3-list-objects", samples, async () => {
        const request = signedR2ListRequest(
          r2Endpoint,
          QUALIFICATION_BUCKET,
          r2AccessId,
          r2AccessKey,
        );
        const response = await fetch(request.url, {
          headers: request.headers,
        });
        if (response.status !== 200) {
          throw new Error(`R2 leg failed with status ${response.status}`);
        }
        const body = await response.text();
        if (qualificationBucketObjects.keys.length === 0) {
          const keyMatches = body.matchAll(/<Key>([^<]+)<\/Key>/gu);
          const sizeMatches = body.matchAll(/<Size>(\d+)<\/Size>/gu);
          qualificationBucketObjects.keys = [...keyMatches]
            .map((match) => match[1]);
          qualificationBucketObjects.bytes = [...sizeMatches]
            .reduce((sum, match) => sum + Number(match[1]), 0);
        }
      }),
    );
    evidence.inventory.qualificationBucket = {
      bucket: QUALIFICATION_BUCKET,
      bytes: qualificationBucketObjects.bytes,
      objectCount: qualificationBucketObjects.keys.length,
    };

    // 5. Cheap deterministic D1 hard-limit observations.
    const manyParameters = `SELECT ${
      Array.from({length: 101}, (_, index) => `?${index + 1}`).join(", ")
    }`;
    evidence.hardLimitObservations.boundParameters101 = await observeLimit(
      "d1-bound-parameters-101",
      () =>
        d1Query(
          token,
          accountId,
          databaseId,
          manyParameters,
          Array.from({length: 101}, () => 1),
        ),
    );
    evidence.hardLimitObservations.statementBytes100500 = await observeLimit(
      "d1-statement-bytes-100500",
      () =>
        d1Query(
          token,
          accountId,
          databaseId,
          `SELECT '${"x".repeat(100_500)}'`,
          [],
        ),
    );
    await d1Query(
      token,
      accountId,
      databaseId,
      "CREATE TABLE probe_rows (id TEXT PRIMARY KEY, body TEXT)",
      [],
    );
    evidence.hardLimitObservations.rowBytes2100000 = await observeLimit(
      "d1-row-bytes-2100000",
      () =>
        d1Query(
          token,
          accountId,
          databaseId,
          "INSERT INTO probe_rows (id, body) VALUES (?1, ?2)",
          ["row-1", "y".repeat(2_100_000)],
        ),
    );

    evidence.success = true;
  } finally {
    // 6. Cleanup: always delete the probe database.
    const deleted = await cloudflareFetch(
      token,
      `/accounts/${accountId}/d1/database/${databaseId}`,
      {method: "DELETE"},
    );
    evidence.cleanup.probeDatabaseDeleted = deleted.status === 200;
    const relisted = await cloudflareFetch(
      token,
      `/accounts/${accountId}/d1/database?per_page=100`,
    );
    const remaining = Array.isArray(relisted.document?.result)
      ? relisted.document.result.map((database) => String(database.name))
      : [];
    evidence.cleanup.probeDatabaseAbsent =
      !remaining.includes(PROBE_DATABASE_NAME);
    console.log(
      `Probe database deleted: ${evidence.cleanup.probeDatabaseDeleted}, ` +
        `absent on re-list: ${evidence.cleanup.probeDatabaseAbsent}.`,
    );
  }

  evidence.finishedAt = new Date().toISOString();
  const timestamp = evidence.finishedAt.replaceAll(/[:.]/gu, "-");
  const packageEvidence = resolve(
    PACKAGE_DIRECTORY,
    "evidence",
    `api-rtt-${timestamp}.json`,
  );
  const repositoryEvidence = resolve(
    REPOSITORY_ROOT,
    "project",
    "evidence",
    "cloudflare-api-rtt.json",
  );
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  await mkdir(dirname(packageEvidence), {recursive: true});
  await writeFile(packageEvidence, serialized);
  await writeFile(repositoryEvidence, serialized);
  console.log(`Evidence written to ${packageEvidence}`);
  console.log(`Evidence written to ${repositoryEvidence}`);
  if (!evidence.success) {
    process.exitCode = 1;
  }
};

await main();
