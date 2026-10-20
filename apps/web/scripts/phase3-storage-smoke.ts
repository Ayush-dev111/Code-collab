import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { getDatabase } from "@collab/db";
import { createRedisFixture } from "./test-support/redis-fixture.ts";
import {
  apiErrorSchema,
  createdProjectResponseSchema,
  imageUploadResponseSchema,
  inviteResponseSchema,
  itemResponseSchema,
  joinInviteResponseSchema,
} from "@collab/shared";
import type { signS3Request } from "../lib/s3-signing";
const rateLimitFixture = await createRedisFixture();

const signingModule: { signS3Request: typeof signS3Request } = await import(
  new URL("../lib/s3-signing.ts", import.meta.url).href
);

const database = getDatabase();
const environmentFile = new URL("../../../.env", import.meta.url);
const originalEnvironmentFile = await readFile(environmentFile);
const applicationUrl = "http://127.0.0.1:3002";
const webDirectory = fileURLToPath(new URL("..", import.meta.url));
const runId = randomUUID();
const emailPrefix = `phase3-storage-${runId}`;
const identities = ["owner", "viewer", "outsider"] as const;
type Identity = (typeof identities)[number];
const emails = identities.map((name) => `${emailPrefix}-${name}@example.test`);
const password = `Phase3-storage-${randomBytes(24).toString("hex")}`;
const accountClients = new Map<Identity, HttpClient>();
const createdProjectIds = new Set<string>();
let cleanupAllowed = false;
let application: ChildProcess | undefined;

// These credentials are generated fixture values, never real S3 credentials.
const fixtureAccessKey = `FIXTURE_${randomBytes(12).toString("hex")}`;
const fixtureSecret = randomBytes(32).toString("hex");
const fixtureSessionToken = randomBytes(24).toString("hex");
const fixtureBucket = `phase3-${randomBytes(8).toString("hex")}`;
const fixtureRegion = "us-east-1";
const objects = new Map<string, { bytes: Buffer; contentType: string }>();
const fixtureFailures: string[] = [];
let signedPutCount = 0;
let signedGetCount = 0;
let getResponseMode: "normal" | "oversized-header" | "redirect" = "normal";

// Public one-pixel PNG fixture; no user image is read or stored by this test.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrVQAAAAASUVORK5CYII=",
  "base64",
);

type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  form?: FormData;
  rawBody?: Uint8Array;
  contentType?: string;
  baseUrl?: string;
};
type ApiResult = {
  status: number;
  headers: Headers;
  body: unknown;
  bytes: Uint8Array | undefined;
};

class HttpClient {
  private readonly cookies = new Map<string, string>();

  async request(
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiResult> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await this.requestOnce(path, options);
      if (
        result.status !== 429 ||
        !path.startsWith("/api/auth/") ||
        attempt === 3
      )
        return result;
      const wait = Number(
        result.headers.get("x-retry-after") ??
          result.headers.get("retry-after"),
      );
      assert.ok(
        Number.isFinite(wait) && wait >= 0 && wait <= 45,
        "Authentication retry delay must be bounded",
      );
      console.log(`WAIT authentication rate limit: ${Math.ceil(wait)} seconds`);
      await delay(Math.ceil(wait * 1000) + 100);
    }
    throw new Error("Authentication retries exceeded their bound");
  }

  private async requestOnce(
    path: string,
    options: RequestOptions,
  ): Promise<ApiResult> {
    const method = options.method ?? "GET";
    const origin = options.baseUrl ?? applicationUrl;
    const headers = new Headers();
    if (this.cookies.size > 0)
      headers.set(
        "Cookie",
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    if (method !== "GET") headers.set("Origin", origin);
    let body: BodyInit | undefined;
    if (options.form) body = options.form;
    else if (options.rawBody) {
      body = new Uint8Array(options.rawBody).buffer;
      headers.set(
        "Content-Type",
        options.contentType ?? "application/octet-stream",
      );
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(new URL(path, origin), {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const first = cookie.split(";")[0];
      if (!first) continue;
      const split = first.indexOf("=");
      if (split < 1) continue;
      const name = first.slice(0, split);
      const value = first.slice(split + 1);
      if (!value || /(?:^|;)\s*max-age=0(?:;|$)/i.test(cookie))
        this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const contentType = response.headers.get("content-type") ?? "";
    let resultBody: unknown;
    let bytes: Uint8Array | undefined;
    if (contentType.includes("application/json"))
      resultBody = await response.json();
    else if (contentType.startsWith("image/"))
      bytes = new Uint8Array(await response.arrayBuffer());
    else await response.body?.cancel();
    return {
      status: response.status,
      headers: response.headers,
      body: resultBody,
      bytes,
    };
  }
}

function client(name: Identity): HttpClient {
  const value = accountClients.get(name);
  assert.ok(value, "Test account must exist");
  return value;
}

function expectStatus(
  result: ApiResult,
  status: number,
  label: string,
): ApiResult {
  assert.equal(result.status, status, `${label}: unexpected HTTP status`);
  return result;
}

async function expectError(
  member: HttpClient,
  path: string,
  status: number,
  label: string,
  options: RequestOptions = {},
): Promise<void> {
  apiErrorSchema.parse(
    expectStatus(await member.request(path, options), status, label).body,
  );
}

function pass(label: string): void {
  console.log(`PASS ${label}`);
}

function pngForm(type = "image/png", bytes: Uint8Array = png): FormData {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(bytes).buffer], { type }),
    "fixture.png",
  );
  return form;
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyFixtureSignature(request: IncomingMessage, bytes: Buffer): void {
  const authorization = request.headers.authorization;
  assert.ok(
    typeof authorization === "string",
    "Fixture request must be signed",
  );
  const match = authorization.match(
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/,
  );
  assert.ok(match, "Fixture signature must use SigV4");
  const [, accessKey, date, region, headerNames, suppliedSignature] = match;
  assert.ok(
    accessKey === fixtureAccessKey && region === fixtureRegion,
    "Fixture credential scope must match",
  );
  assert.ok(date && headerNames && suppliedSignature);
  const names = headerNames.split(";");
  assert.deepEqual(
    names,
    [...names].sort(),
    "Signed headers must use ASCII order",
  );
  for (const required of [
    "host",
    "x-amz-content-sha256",
    "x-amz-date",
    "x-amz-security-token",
  ])
    assert.ok(
      names.includes(required),
      "Required fixture header must be signed",
    );
  const payloadHash = sha256(bytes);
  assert.ok(
    request.headers["x-amz-content-sha256"] === payloadHash,
    "Fixture payload hash must match actual bytes",
  );
  assert.ok(
    request.headers["x-amz-security-token"] === fixtureSessionToken,
    "Fixture session token must be present and signed",
  );
  const timestamp = request.headers["x-amz-date"];
  assert.ok(
    typeof timestamp === "string" &&
      /^\d{8}T\d{6}Z$/.test(timestamp) &&
      timestamp.startsWith(date),
    "Fixture timestamp must match scope",
  );
  const url = new URL(request.url ?? "/", "http://fixture.invalid");
  assert.equal(
    url.search,
    "",
    "Fixture object request cannot contain query data",
  );
  assert.ok(
    url.pathname.startsWith(`/${fixtureBucket}/projects/`),
    "Only the generated fixture bucket is accessible",
  );
  const canonicalHeaders = names
    .map((name) => {
      const value = request.headers[name];
      assert.equal(typeof value, "string", "Signed fixture header must exist");
      assert.ok(typeof value === "string");
      return `${name}:${value.trim().replace(/\s+/g, " ")}\n`;
    })
    .join("");
  const canonical = `${request.method}\n${url.pathname}\n\n${canonicalHeaders}\n${headerNames}\n${payloadHash}`;
  const scope = `${date}/${region}/s3/aws4_request`;
  let key: Buffer = Buffer.from(`AWS4${fixtureSecret}`, "utf8");
  for (const value of [date, region, "s3", "aws4_request"])
    key = createHmac("sha256", key).update(value).digest();
  const expected = createHmac("sha256", key)
    .update(`AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonical)}`)
    .digest();
  const actual = Buffer.from(suppliedSignature, "hex");
  assert.ok(
    actual.length === expected.length && timingSafeEqual(actual, expected),
    "Fixture signature must match independently calculated canonical request",
  );
}

async function serveFixture(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of request) {
      const chunk =
        value instanceof Buffer ? value : Buffer.from(value as Uint8Array);
      size += chunk.byteLength;
      assert.ok(size <= 8 * 1024 * 1024, "Fixture request must be bounded");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    verifyFixtureSignature(request, bytes);
    const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    if (request.method === "PUT") {
      assert.equal(request.headers["content-type"], "image/png");
      assert.ok(
        bytes.equals(png),
        "Fixture only accepts its generated PNG bytes",
      );
      signedPutCount += 1;
      objects.set(path, { bytes, contentType: "image/png" });
      response.writeHead(200, { "Content-Length": "0" });
      response.end();
      return;
    }
    assert.equal(
      request.method,
      "GET",
      "Fixture supports only object PUT and GET",
    );
    signedGetCount += 1;
    if (getResponseMode === "redirect") {
      response.writeHead(302, {
        Location: "/redirect-disallowed",
        "Content-Length": "0",
      });
      response.end();
      return;
    }
    const object = objects.get(path);
    if (!object) {
      response.writeHead(404, { "Content-Length": "0" });
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": object.contentType,
      "Content-Length": String(
        getResponseMode === "oversized-header"
          ? 8 * 1024 * 1024 + 1
          : object.bytes.byteLength,
      ),
    });
    response.end(object.bytes);
  } catch {
    fixtureFailures.push(
      "Fixture rejected an invalid signature, scope, payload or method",
    );
    if (!response.headersSent)
      response.writeHead(403, { "Content-Length": "0" });
    response.end();
  }
}

const fixture = createServer((request, response) => {
  void serveFixture(request, response);
});

function officialSignatureVector(): void {
  // Public AWS reference: /AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
  const headers = signingModule.signS3Request({
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    range: "bytes=0-9",
    now: new Date("2013-05-24T00:00:00.000Z"),
  });
  assert.ok(
    headers
      .get("authorization")
      ?.endsWith(
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
      ),
    "Signer must reproduce AWS's published GET-object signature",
  );
  pass("SigV4 signer reproduces the official AWS signature vector");
}

async function startProduction(storageConfigured = true): Promise<void> {
  const portProbe = createServer();
  await new Promise<void>((resolve, reject) => {
    portProbe.once("error", () =>
      reject(
        new Error("Leave port 3002 free for the isolated production test"),
      ),
    );
    portProbe.listen(3002, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
  if (!fixture.listening) {
    await new Promise<void>((resolve, reject) => {
      fixture.once("error", reject);
      fixture.listen(0, "127.0.0.1", () => {
        fixture.off("error", reject);
        resolve();
      });
    });
  }
  const address = fixture.address();
  assert.ok(
    address && typeof address !== "string",
    "Fixture must listen on an isolated loopback port",
  );
  const endpoint = `http://127.0.0.1:${address.port}`;
  let exited = false;
  let startupError = false;
  let childReady = false;
  let startupText = "";
  application = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./next.ts", import.meta.url)),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3002",
    ],
    {
      cwd: webDirectory,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "production",
        BETTER_AUTH_URL: applicationUrl,
        REDIS_URL: rateLimitFixture.url,
        SENTRY_DSN: "",
        NEXT_PUBLIC_SENTRY_DSN: "",
        S3_ENDPOINT: endpoint,
        S3_REGION: fixtureRegion,
        S3_BUCKET: fixtureBucket,
        S3_ACCESS_KEY_ID: storageConfigured ? fixtureAccessKey : "",
        S3_SECRET_ACCESS_KEY: storageConfigured ? fixtureSecret : "",
        S3_SESSION_TOKEN: fixtureSessionToken,
        S3_FORCE_PATH_STYLE: "true",
      },
    },
  );
  // Do not forward child logs. Check the readiness marker from this specific
  // child before making requests so a different service on 3002 is never used.
  const readStartup = (chunk: Buffer) => {
    startupText = `${startupText}${chunk.toString("utf8")}`.slice(-2000);
    if (/\bReady in\b/i.test(startupText)) childReady = true;
  };
  application.stdout?.on("data", readStartup);
  application.stderr?.on("data", readStartup);
  application.once("exit", () => {
    exited = true;
  });
  application.once("error", () => {
    startupError = true;
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    assert.ok(
      !exited && !startupError,
      "Production server failed to start; build apps/web before this smoke test and leave port 3002 free",
    );
    if (!childReady) {
      await delay(100);
      continue;
    }
    try {
      const response = await fetch(`${applicationUrl}/login`, {
        signal: AbortSignal.timeout(1000),
      });
      await response.body?.cancel();
      if (response.status === 200) {
        pass(
          storageConfigured
            ? "Isolated production server uses fixture S3 settings without changing .env"
            : "Isolated production server starts with missing storage credentials",
        );
        return;
      }
    } catch {
      /* The isolated server has not finished starting yet. */
    }
    await delay(100);
  }
  throw new Error("Isolated production server did not become ready");
}

async function run(): Promise<void> {
  officialSignatureVector();
  await startProduction();
  assert.equal(
    await database.user.count({ where: { email: { in: emails } } }),
    0,
    "Generated accounts must not already exist",
  );
  cleanupAllowed = true;
  for (const name of identities) {
    const account = new HttpClient();
    accountClients.set(name, account);
    expectStatus(
      await account.request("/api/auth/sign-up/email", {
        method: "POST",
        body: {
          name: `Phase 3 storage ${name}`,
          email: `${emailPrefix}-${name}@example.test`,
          password,
        },
      }),
      200,
      "Fixture account signup",
    );
  }
  const { project } = createdProjectResponseSchema.parse(
    expectStatus(
      await client("owner").request("/api/projects", {
        method: "POST",
        body: { name: `Storage smoke ${runId}` },
      }),
      201,
      "Fixture project creation",
    ).body,
  );
  createdProjectIds.add(project.id);
  const { item } = itemResponseSchema.parse(
    expectStatus(
      await client("owner").request(`/api/projects/${project.id}/items`, {
        method: "POST",
        body: { type: "PAGE", title: "Storage smoke page", parentId: null },
      }),
      201,
      "Fixture page creation",
    ).body,
  );
  const { invite } = inviteResponseSchema.parse(
    expectStatus(
      await client("owner").request(`/api/projects/${project.id}/invites`, {
        method: "POST",
        body: { role: "VIEWER", expiresInDays: 1 },
      }),
      201,
      "Viewer invite creation",
    ).body,
  );
  assert.equal(
    joinInviteResponseSchema.parse(
      expectStatus(
        await client("viewer").request(`/api/invites/${invite.code}/join`, {
          method: "POST",
          body: {},
        }),
        200,
        "Viewer joins",
      ).body,
    ).role,
    "VIEWER",
  );
  const uploadPath = `/api/projects/${project.id}/items/${item.id}/images`;
  const anonymous = new HttpClient();
  for (const [account, status] of [
    [anonymous, 401],
    [client("viewer"), 403],
    [client("outsider"), 403],
  ] as const)
    await expectError(account, uploadPath, status, "Image write permission", {
      method: "POST",
      form: pngForm(),
    });
  assert.equal(objects.size, 0, "Denied uploads must not reach S3");
  const uploaded = imageUploadResponseSchema.parse(
    expectStatus(
      await client("owner").request(uploadPath, {
        method: "POST",
        form: pngForm(),
      }),
      201,
      "Owner uploads private PNG",
    ).body,
  );
  assert.equal(objects.size, 1);
  assert.equal(signedPutCount, 1);
  for (const account of [client("owner"), client("viewer")]) {
    const response = expectStatus(
      await account.request(uploaded.url),
      200,
      "Authorized image read",
    );
    assert.ok(
      response.bytes && Buffer.from(response.bytes).equals(png),
      "Private image bytes must match uploaded bytes",
    );
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.ok(
      response.headers.get("content-security-policy")?.includes("sandbox"),
    );
  }
  const beforeDeniedReads = signedGetCount;
  await expectError(
    anonymous,
    uploaded.url,
    401,
    "Anonymous private image read",
  );
  await expectError(
    client("outsider"),
    uploaded.url,
    403,
    "Outsider private image read",
  );
  assert.equal(
    signedGetCount,
    beforeDeniedReads,
    "Denied image reads must not reach S3",
  );
  pass(
    "Private image upload and read enforce project roles; signed S3 requests preserve PNG bytes and private response headers",
  );

  await expectError(client("owner"), uploadPath, 400, "MIME spoof", {
    method: "POST",
    form: pngForm("image/jpeg"),
  });
  await expectError(client("owner"), uploadPath, 400, "Spoofed PNG body", {
    method: "POST",
    form: pngForm("image/png", Buffer.from("This is not a PNG")),
  });
  await expectError(client("owner"), uploadPath, 400, "SVG disallowed", {
    method: "POST",
    form: pngForm(
      "image/svg+xml",
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    ),
  });
  const extraField = pngForm();
  extraField.append("role", "OWNER");
  await expectError(
    client("owner"),
    uploadPath,
    400,
    "Extraneous multipart field",
    { method: "POST", form: extraField },
  );
  const duplicate = pngForm();
  duplicate.append(
    "file",
    new Blob([new Uint8Array(png).buffer], { type: "image/png" }),
    "duplicate.png",
  );
  await expectError(client("owner"), uploadPath, 400, "Duplicate file", {
    method: "POST",
    form: duplicate,
  });
  await expectError(client("owner"), uploadPath, 400, "Malformed multipart", {
    method: "POST",
    rawBody: Buffer.from("not-multipart"),
    contentType: "multipart/form-data; boundary=fixture-invalid",
  });
  const oversized = expectStatus(
    await client("owner").request(uploadPath, {
      method: "POST",
      form: pngForm("image/png", new Uint8Array(8 * 1024 * 1024 + 1)),
    }),
    400,
    "Oversized image schema rejection",
  );
  apiErrorSchema.parse(oversized.body);
  assert.equal(signedPutCount, 1, "Invalid images must not reach S3");
  await expectError(
    client("owner"),
    `${uploaded.url}?unknown=1`,
    400,
    "Unexpected image query",
  );
  pass(
    "Image validation rejects MIME spoofing, SVG, duplicate fields, malformed multipart and oversized uploads before S3",
  );

  getResponseMode = "oversized-header";
  await expectError(
    client("owner"),
    uploaded.url,
    502,
    "Oversized upstream image",
  );
  getResponseMode = "redirect";
  await expectError(
    client("owner"),
    uploaded.url,
    502,
    "Storage redirect must not be followed",
  );
  getResponseMode = "normal";
  await expectError(
    client("owner"),
    `${uploadPath}/${randomUUID()}.png`,
    404,
    "Unknown S3 image",
  );
  assert.deepEqual(
    fixtureFailures,
    [],
    "All storage requests must satisfy independently verified signing and scope",
  );
  pass(
    "Storage responses reject oversized objects and redirects; missing images return 404",
  );

  await stopProduction();
  await startProduction(false);
  const beforeMissingConfiguration = signedPutCount;
  await expectError(
    client("owner"),
    uploadPath,
    503,
    "Missing storage configuration",
    { method: "POST", form: pngForm() },
  );
  assert.equal(
    signedPutCount,
    beforeMissingConfiguration,
    "Missing configuration must not reach storage",
  );
  pass(
    "Missing S3 credentials report 503 without contacting storage or changing .env",
  );
}

async function stopProduction(): Promise<void> {
  const child = application;
  application = undefined;
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill();
    await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
}

async function cleanup(): Promise<void> {
  await stopProduction();
  fixture.closeAllConnections();
  if (fixture.listening)
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  objects.clear();
  if (!cleanupAllowed) return;
  const users = await database.user.findMany({
    where: { email: { in: emails } },
    select: { id: true, email: true },
  });
  for (const user of users)
    assert.ok(
      user.email.startsWith(`${emailPrefix}-`) &&
        user.email.endsWith("@example.test"),
      "Cleanup identity guard failed",
    );
  const userIds = users.map((user) => user.id);
  const projects = await database.project.findMany({
    where: { ownerId: { in: userIds } },
    select: { id: true },
  });
  for (const project of projects) createdProjectIds.add(project.id);
  await database.project.deleteMany({
    where: { id: { in: [...createdProjectIds] }, ownerId: { in: userIds } },
  });
  await database.user.deleteMany({ where: { id: { in: userIds } } });
  assert.ok(
    originalEnvironmentFile.equals(await readFile(environmentFile)),
    "Storage test must preserve the original .env file",
  );
}

let failed = false;
try {
  await run();
} catch (error: unknown) {
  failed = true;
  console.error(
    `FAIL ${error instanceof Error ? error.message : "Unknown storage smoke error"}`,
  );
} finally {
  try {
    await cleanup();
    pass(
      "Guarded cleanup stops the isolated server and removes only generated fixture accounts, projects and images",
    );
  } catch (error: unknown) {
    failed = true;
    console.error(
      `FAIL cleanup: ${error instanceof Error ? error.message : "Unknown cleanup error"}`,
    );
  } finally {
    await database.$disconnect();
    await rateLimitFixture.close();
  }
}
if (failed) process.exitCode = 1;
else console.log("Phase 3 private image storage smoke checks passed.");
