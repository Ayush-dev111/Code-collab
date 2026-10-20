import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getDatabase } from "@collab/db";
import {
  apiErrorSchema,
  createdProjectResponseSchema,
  inviteResponseSchema,
  invitePreviewResponseSchema,
  joinInviteResponseSchema,
  projectResponseSchema,
  projectsResponseSchema,
} from "@collab/shared";

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  rawBody?: string;
  origin?: string;
  cookie?: string;
};

type ApiResult = {
  status: number;
  headers: Headers;
  body: unknown;
  html: string | undefined;
};

const baseUrl = new URL(process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000")
  .origin;
const database = getDatabase();
const runId = randomUUID();
const emailPrefix = `phase1-${runId}`;
const password = `Phase1-${randomBytes(24).toString("hex")}`;
const names = ["owner", "editor", "viewer", "outsider"] as const;
type IdentityName = (typeof names)[number];
const emails = names.map((name) => `${emailPrefix}-${name}@example.test`);
const invalidEmails = [
  `${emailPrefix}-short@example.test`,
  `${emailPrefix}-role@example.test`,
];
const allEmails = [...emails, ...invalidEmails];
const createdProjectIds = new Set<string>();
let cleanupAllowed = false;
const MAX_AUTH_RETRIES = 3;
const MAX_AUTH_RETRY_WAIT_MS = 45_000;

function authRetryDelay(headers: Headers): number | undefined {
  // Better Auth documents X-Retry-After in seconds; accept standard Retry-After too.
  const value = headers.get("x-retry-after") ?? headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000) + 100;
  }
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt)
    ? Math.max(0, retryAt - Date.now()) + 100
    : undefined;
}

// Keep cookies in memory. Never print passwords, session cookies or auth bodies.
class Client {
  private readonly cookies = new Map<string, string>();

  cookieHeader(): string {
    return [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  async request(
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiResult> {
    let waited = 0;
    for (let attempt = 0; attempt <= MAX_AUTH_RETRIES; attempt += 1) {
      const result = await this.requestOnce(path, options);
      if (
        result.status !== 429 ||
        !path.startsWith("/api/auth/") ||
        attempt === MAX_AUTH_RETRIES
      ) {
        return result;
      }
      const waitMs = authRetryDelay(result.headers);
      assert.ok(
        waitMs !== undefined,
        "Authentication rate limits must provide a valid retry delay",
      );
      if (waited + waitMs > MAX_AUTH_RETRY_WAIT_MS) return result;
      waited += waitMs;
      console.log(
        `WAIT authentication rate limit; retrying in ${Math.ceil(waitMs / 1_000)} seconds`,
      );
      await delay(waitMs);
    }
    throw new Error("Authentication retries exceeded their configured bound");
  }

  private async requestOnce(
    path: string,
    options: RequestOptions,
  ): Promise<ApiResult> {
    const method = options.method ?? "GET";
    const headers = new Headers();
    const cookie = options.cookie ?? this.cookieHeader();
    if (cookie) headers.set("Cookie", cookie);
    if (method !== "GET") {
      headers.set("Origin", options.origin ?? baseUrl);
      headers.set("Content-Type", "application/json");
    }
    const body =
      options.rawBody ??
      (options.body === undefined ? undefined : JSON.stringify(options.body));
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    for (const value of response.headers.getSetCookie()) {
      const first = value.split(";")[0];
      if (!first) continue;
      const split = first.indexOf("=");
      if (split < 1) continue;
      const name = first.slice(0, split);
      const cookieValue = first.slice(split + 1);
      if (!cookieValue || /(?:^|;)\s*max-age=0(?:;|$)/i.test(value)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, cookieValue);
      }
    }
    let responseBody: unknown;
    let html: string | undefined;
    if (response.headers.get("content-type")?.includes("application/json")) {
      responseBody = await response.json();
    } else if (response.headers.get("content-type")?.includes("text/html")) {
      html = await response.text();
    }
    return {
      status: response.status,
      headers: response.headers,
      body: responseBody,
      html,
    };
  }
}

function status(result: ApiResult, expected: number, label: string): ApiResult {
  assert.equal(result.status, expected, `${label}: unexpected HTTP status`);
  return result;
}

async function expectError(
  client: Client,
  path: string,
  expected: number,
  label: string,
  options: RequestOptions = {},
): Promise<void> {
  const result = status(await client.request(path, options), expected, label);
  apiErrorSchema.parse(result.body);
}

function pass(label: string): void {
  console.log(`PASS ${label}`);
}

function pageHtml(result: ApiResult, label: string): string {
  status(result, 200, label);
  assert.equal(typeof result.html, "string", `${label}: expected HTML`);
  assert.ok(result.html, `${label}: expected a rendered document`);
  return result.html;
}

function hasButton(html: string, text: "Rename" | "Invite members"): boolean {
  return new RegExp(`<button\\b[^>]*>\\s*${text}\\s*</button>`).test(html);
}

function redirectTarget(result: ApiResult): URL {
  if ([302, 303, 307, 308].includes(result.status)) {
    const location = result.headers.get("location");
    assert.ok(location, "Redirect must supply its destination");
    return new URL(location, baseUrl);
  }
  // Next.js emits a refresh tag when async page rendering has already streamed.
  const html = pageHtml(result, "streamed page redirect");
  const redirectMeta = html.match(
    /<meta\b(?=[^>]*\bid="__next-page-redirect")(?=[^>]*\bhttp-equiv="refresh")[^>]*\bcontent="\d+;url=([^"]+)"[^>]*>/,
  );
  const location = redirectMeta?.[1];
  assert.ok(
    location && html.includes("NEXT_REDIRECT"),
    "Unauthenticated page must emit an HTTP or Next.js streamed redirect",
  );
  return new URL(location.replaceAll("&amp;", "&"), baseUrl);
}

const anonymous = new Client();
const clients = Object.fromEntries(
  names.map((name) => [name, new Client()]),
) as Record<IdentityName, Client>;
const userIds = new Map<IdentityName, string>();

function userId(name: IdentityName): string {
  const id = userIds.get(name);
  assert.ok(id, "Test account must exist before testing its permissions");
  return id;
}

async function run(): Promise<void> {
  // The cleanup below is limited to unique identities created by this run.
  const existing = await database.user.count({
    where: { email: { in: allEmails } },
  });
  assert.equal(existing, 0, "Generated test identities must not already exist");
  cleanupAllowed = true;

  await expectError(anonymous, "/api/projects", 401, "anonymous projects list");
  await expectError(anonymous, "/api/projects", 401, "forged session cookie", {
    cookie: "better-auth.session_token=forged.invalid-signature",
  });
  const protectedPage = await anonymous.request("/projects");
  assert.ok(
    [302, 303, 307, 308].includes(protectedPage.status),
    "Anonymous /projects must redirect",
  );
  const location = protectedPage.headers.get("location");
  assert.ok(location, "Protected page must supply a redirect location");
  assert.equal(
    new URL(location, baseUrl).pathname,
    "/login",
    "Protected page must redirect to login",
  );
  pass("anonymous API access, forged sessions and protected page redirect");

  for (const path of ["/login", "/signup"] as const) {
    const html = pageHtml(await anonymous.request(path), "authentication page");
    assert.ok(/<form\b/.test(html), "Authentication page must render a form");
    assert.ok(
      /<input\b(?=[^>]*\bname="email")(?=[^>]*\btype="email")[^>]*>/.test(html),
      "Authentication form must render an email input",
    );
    assert.ok(
      /<input\b(?=[^>]*\bname="password")(?=[^>]*\btype="password")[^>]*>/.test(
        html,
      ),
      "Authentication form must render a password input",
    );
    if (path === "/signup") {
      assert.ok(
        /<input\b[^>]*\bname="name"[^>]*>/.test(html),
        "Signup form must render a name input",
      );
    }
    assert.ok(
      /<button\b[^>]*\btype="submit"[^>]*>/.test(html),
      "Authentication form must render a submit button",
    );
  }
  pass("login and signup pages render their expected forms on the server");

  await expectError(
    anonymous,
    "/api/auth/sign-up/email",
    400,
    "short signup password",
    {
      method: "POST",
      body: { name: "Invalid", email: invalidEmails[0], password: "short" },
    },
  );
  await expectError(
    anonymous,
    "/api/auth/sign-up/email",
    400,
    "signup role injection",
    {
      method: "POST",
      body: {
        name: "Invalid",
        email: invalidEmails[1],
        password,
        role: "OWNER",
      },
    },
  );
  assert.equal(
    await database.user.count({ where: { email: { in: invalidEmails } } }),
    0,
    "Invalid signups must not persist users",
  );
  for (const name of names) {
    const email = `${emailPrefix}-${name}@example.test`;
    status(
      await clients[name].request("/api/auth/sign-up/email", {
        method: "POST",
        body: { name: `Phase 1 ${name}`, email, password },
      }),
      200,
      `${name} signup`,
    );
    assert.ok(
      clients[name].cookieHeader(),
      "Signup must issue a session cookie",
    );
    const user = await database.user.findUniqueOrThrow({ where: { email } });
    userIds.set(name, user.id);
  }
  pass("email signup validates input and establishes authenticated sessions");

  const createResult = status(
    await clients.owner.request("/api/projects", {
      method: "POST",
      body: { name: `Phase 1 smoke ${runId}` },
    }),
    201,
    "create project",
  );
  const { project } = createdProjectResponseSchema.parse(createResult.body);
  createdProjectIds.add(project.id);
  assert.equal(project.role, "OWNER");
  const storedProject = await database.project.findUniqueOrThrow({
    where: { id: project.id },
    include: { members: true },
  });
  assert.equal(storedProject.ownerId, userId("owner"));
  assert.equal(storedProject.members.length, 1);
  assert.equal(storedProject.members[0]?.userId, storedProject.ownerId);
  assert.equal(storedProject.members[0]?.role, "OWNER");
  const ownerList = projectsResponseSchema.parse(
    status(await clients.owner.request("/api/projects"), 200, "owner projects")
      .body,
  );
  assert.deepEqual(
    ownerList.projects.map((entry) => entry.id),
    [project.id],
  );
  const outsiderList = projectsResponseSchema.parse(
    status(
      await clients.outsider.request("/api/projects"),
      200,
      "outsider projects",
    ).body,
  );
  assert.equal(outsiderList.projects.length, 0);
  pass(
    "project creation persists its owner membership and scopes project lists",
  );

  const projectPath = `/api/projects/${project.id}`;
  for (const [path, method, body] of [
    [projectPath, "GET", undefined],
    [projectPath, "PATCH", { name: "Forbidden rename" }],
    [`${projectPath}/invites`, "POST", { role: "EDITOR", expiresInDays: 7 }],
  ] as const) {
    await expectError(clients.outsider, path, 403, "outsider project access", {
      method,
      ...(body === undefined ? {} : { body }),
    });
    await expectError(anonymous, path, 401, "anonymous direct project access", {
      method,
      ...(body === undefined ? {} : { body }),
    });
  }
  pass("direct project endpoints reject outsiders and missing authentication");

  const invites = new Map<"EDITOR" | "VIEWER", string>();
  for (const role of ["EDITOR", "VIEWER"] as const) {
    const result = status(
      await clients.owner.request(`${projectPath}/invites`, {
        method: "POST",
        body: { role, expiresInDays: 7 },
      }),
      201,
      "owner creates invite",
    );
    const { invite } = inviteResponseSchema.parse(result.body);
    assert.equal(invite.role, role);
    assert.equal(new URL(invite.url).origin, baseUrl);
    invites.set(role, invite.code);
    const anonymousInvitePage = await anonymous.request(
      `/invite/${invite.code}`,
    );
    const loginLocation = redirectTarget(anonymousInvitePage);
    assert.equal(loginLocation.origin, baseUrl);
    assert.equal(loginLocation.pathname, "/login");
    assert.ok(
      loginLocation.searchParams.get("callbackURL") ===
        `/invite/${invite.code}`,
      "Invitation login redirect must preserve the invitation return path",
    );
    const member = role === "EDITOR" ? clients.editor : clients.viewer;
    const previewPath = `/api/invites/${invite.code}`;
    await expectError(anonymous, previewPath, 401, "anonymous invite preview");
    await expectError(
      anonymous,
      `${previewPath}/join`,
      401,
      "anonymous invite join",
      { method: "POST", body: {} },
    );
    const preview = invitePreviewResponseSchema.parse(
      status(await member.request(previewPath), 200, "invite preview").body,
    ).invite;
    assert.equal(preview.projectId, project.id);
    assert.equal(preview.role, role);
    assert.equal(preview.isMember, false);
    await expectError(
      member,
      `${previewPath}/join`,
      400,
      "join role injection",
      {
        method: "POST",
        body: { role: "OWNER", userId: userId("owner") },
      },
    );
    const concurrentJoins = await Promise.all([
      member.request(`${previewPath}/join`, { method: "POST", body: {} }),
      member.request(`${previewPath}/join`, { method: "POST", body: {} }),
    ]);
    for (const joinResult of concurrentJoins) {
      const joined = joinInviteResponseSchema.parse(
        status(joinResult, 200, "concurrent invite join").body,
      );
      assert.equal(joined.projectId, project.id);
      assert.equal(joined.role, role);
    }
    assert.equal(
      await database.projectMember.count({
        where: {
          projectId: project.id,
          userId: userId(role === "EDITOR" ? "editor" : "viewer"),
          role,
        },
      }),
      1,
      "Concurrent joins must create exactly one membership",
    );
    const afterJoin = invitePreviewResponseSchema.parse(
      status(await member.request(previewPath), 200, "member invite preview")
        .body,
    ).invite;
    assert.equal(afterJoin.isMember, true);
  }
  pass(
    "owner invites grant their stored role, reject forged roles and handle concurrent joins",
  );
  pass("anonymous invitation pages preserve their return path through login");

  for (const name of ["editor", "viewer"] as const) {
    const memberProject = projectResponseSchema.parse(
      status(
        await clients[name].request(projectPath),
        200,
        "member reads project",
      ).body,
    ).project;
    assert.equal(memberProject.id, project.id);
    assert.equal(memberProject.role, name === "editor" ? "EDITOR" : "VIEWER");
    const memberList = projectsResponseSchema.parse(
      status(
        await clients[name].request("/api/projects"),
        200,
        "member projects",
      ).body,
    );
    assert.deepEqual(
      memberList.projects.map((entry) => entry.id),
      [project.id],
    );
    await expectError(
      clients[name],
      `${projectPath}/invites`,
      403,
      "nonowner invite creation",
      { method: "POST", body: { role: "VIEWER", expiresInDays: 7 } },
    );
  }
  const renamed = projectResponseSchema.parse(
    status(
      await clients.editor.request(projectPath, {
        method: "PATCH",
        body: { name: "Phase 1 editor rename" },
      }),
      200,
      "editor rename",
    ).body,
  ).project;
  assert.equal(renamed.name, "Phase 1 editor rename");
  await expectError(clients.viewer, projectPath, 403, "viewer rename", {
    method: "PATCH",
    body: { name: "Forbidden viewer rename" },
  });
  await expectError(clients.owner, projectPath, 400, "rename role injection", {
    method: "PATCH",
    body: { name: "Forged role", role: "OWNER" },
  });
  await expectError(
    clients.owner,
    `${projectPath}/invites`,
    400,
    "owner role invite injection",
    { method: "POST", body: { role: "OWNER", expiresInDays: 7 } },
  );
  pass("editor and viewer permissions are enforced on the server");

  for (const name of ["owner", "editor", "viewer"] as const) {
    const html = pageHtml(
      await clients[name].request(`/projects/${project.id}`),
      "authenticated project page",
    );
    const titles = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)];
    assert.ok(
      titles.some((title) => title[1]?.includes(renamed.name)),
      "Project page must render the current project name in its heading",
    );
    assert.ok(
      /<aside\b[^>]*\baria-label="Project sidebar"[^>]*>/.test(html),
      "Project page must render its sidebar",
    );
    assert.ok(
      /<section\b[^>]*\baria-labelledby="room-title"[^>]*>/.test(html),
      "Project page must render its center workspace",
    );
    assert.ok(
      /<aside\b[^>]*\baria-labelledby="chat-title"[^>]*>/.test(html) &&
        /<h2\b[^>]*\bid="chat-title"[^>]*>\s*Team chat\s*<\/h2>/.test(html),
      "Project page must render its team chat panel",
    );
    assert.equal(
      hasButton(html, "Rename"),
      name !== "viewer",
      "Rename visibility must follow the server-provided project role",
    );
    assert.equal(
      hasButton(html, "Invite members"),
      name === "owner",
      "Invite visibility must follow the server-provided project role",
    );
  }
  pass(
    "project pages render the room layout and role-appropriate controls on the server",
  );

  const viewerInviteCode = invites.get("VIEWER");
  assert.ok(viewerInviteCode);
  for (const name of ["owner", "editor"] as const) {
    const joined = joinInviteResponseSchema.parse(
      status(
        await clients[name].request(`/api/invites/${viewerInviteCode}/join`, {
          method: "POST",
          body: {},
        }),
        200,
        "existing member joins lower role invite",
      ).body,
    );
    assert.equal(joined.role, name === "owner" ? "OWNER" : "EDITOR");
  }
  pass("rejoining through a lower role invite preserves existing membership");

  const missingInvite = `/api/invites/${randomUUID()}`;
  await expectError(
    clients.outsider,
    missingInvite,
    404,
    "unknown invite preview",
  );
  await expectError(
    clients.outsider,
    `${missingInvite}/join`,
    404,
    "unknown invite join",
    { method: "POST", body: {} },
  );
  const expiredInvite = inviteResponseSchema.parse(
    status(
      await clients.owner.request(`${projectPath}/invites`, {
        method: "POST",
        body: { role: "EDITOR", expiresInDays: 7 },
      }),
      201,
      "create expiry test invite",
    ).body,
  ).invite;
  await database.invite.update({
    where: { code: expiredInvite.code },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  await expectError(
    clients.outsider,
    `/api/invites/${expiredInvite.code}`,
    410,
    "expired invite preview",
  );
  await expectError(
    clients.outsider,
    `/api/invites/${expiredInvite.code}/join`,
    410,
    "expired invite join",
    { method: "POST", body: {} },
  );
  assert.equal(
    await database.projectMember.count({
      where: { projectId: project.id, userId: userId("outsider") },
    }),
    0,
    "Invalid invites must not create membership",
  );
  pass("unknown and expired invite previews and joins are rejected");

  await expectError(clients.owner, projectPath, 403, "cross site mutation", {
    method: "PATCH",
    origin: "https://untrusted.example.test",
    body: { name: "Cross site rename" },
  });
  await expectError(clients.owner, "/api/projects", 400, "malformed JSON", {
    method: "POST",
    rawBody: "{",
  });
  await expectError(
    clients.owner,
    "/api/projects",
    400,
    "create role injection",
    {
      method: "POST",
      body: {
        name: "Role injection",
        ownerId: userId("outsider"),
        role: "OWNER",
      },
    },
  );
  pass(
    "mutation origin checks and strict JSON validation reject unsafe inputs",
  );

  const editorOldCookies = clients.editor.cookieHeader();
  status(
    await clients.editor.request("/api/auth/sign-out", {
      method: "POST",
      body: {},
    }),
    200,
    "sign out",
  );
  await expectError(clients.editor, "/api/projects", 401, "signed out access");
  await expectError(anonymous, "/api/projects", 401, "revoked cookie replay", {
    cookie: editorOldCookies,
  });
  await expectError(
    clients.editor,
    "/api/auth/sign-in/email",
    401,
    "incorrect password sign in",
    {
      method: "POST",
      body: {
        email: `${emailPrefix}-editor@example.test`,
        password: `Incorrect-${randomUUID()}`,
      },
    },
  );
  status(
    await clients.editor.request("/api/auth/sign-in/email", {
      method: "POST",
      body: { email: `${emailPrefix}-editor@example.test`, password },
    }),
    200,
    "password sign in",
  );
  projectsResponseSchema.parse(
    status(
      await clients.editor.request("/api/projects"),
      200,
      "signed in access",
    ).body,
  );
  pass("password sign in works and sign out revokes saved session cookies");

  const viewerUserId = userId("viewer");
  const viewerMembership = { projectId: project.id, userId: viewerUserId };
  await database.projectMember.update({
    where: { projectId_userId: viewerMembership },
    data: { role: "EDITOR" },
  });
  const freshProject = projectResponseSchema.parse(
    status(
      await clients.viewer.request(projectPath, {
        method: "PATCH",
        body: { name: "Phase 1 fresh permission" },
      }),
      200,
      "fresh elevated membership",
    ).body,
  ).project;
  assert.equal(freshProject.role, "EDITOR");
  await database.projectMember.update({
    where: { projectId_userId: viewerMembership },
    data: { role: "VIEWER" },
  });
  await expectError(
    clients.viewer,
    projectPath,
    403,
    "fresh revoked permission",
    {
      method: "PATCH",
      body: { name: "Stale role rename" },
    },
  );
  const outsiderUserId = userId("outsider");
  await database.session.updateMany({
    where: { userId: outsiderUserId },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  await expectError(clients.outsider, "/api/projects", 401, "expired session");
  pass(
    "membership changes and session expiry take effect without client claims",
  );
}

async function cleanup(): Promise<void> {
  if (!cleanupAllowed) return;
  const users = await database.user.findMany({
    where: { email: { in: allEmails } },
    select: { id: true, email: true },
  });
  for (const user of users) {
    assert.ok(
      user.email.startsWith(`${emailPrefix}-`) &&
        user.email.endsWith("@example.test"),
      "Cleanup identity guard failed",
    );
  }
  const ids = users.map((user) => user.id);
  const projects = await database.project.findMany({
    where: { ownerId: { in: ids } },
    select: { id: true },
  });
  for (const project of projects) createdProjectIds.add(project.id);
  await database.project.deleteMany({
    where: { id: { in: [...createdProjectIds] }, ownerId: { in: ids } },
  });
  await database.user.deleteMany({ where: { id: { in: ids } } });
}

let failed = false;
try {
  await run();
} catch (error: unknown) {
  failed = true;
  console.error(
    `FAIL ${error instanceof Error ? error.message : "Unknown smoke test error"}`,
  );
} finally {
  try {
    await cleanup();
    pass("cleanup removes only this run's test users and projects");
  } catch (error: unknown) {
    failed = true;
    console.error(
      `FAIL cleanup: ${error instanceof Error ? error.message : "Unknown cleanup error"}`,
    );
  } finally {
    await database.$disconnect();
  }
}
if (failed) process.exitCode = 1;
else console.log("Phase 1 HTTP smoke checks passed.");
