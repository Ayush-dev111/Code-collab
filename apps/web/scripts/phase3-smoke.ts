import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getDatabase } from "@collab/db";
import {
  apiErrorSchema,
  awarenessStateSchema,
  createdProjectResponseSchema,
  deleteItemsResponseSchema,
  inviteResponseSchema,
  itemResponseSchema,
  itemsResponseSchema,
  joinInviteResponseSchema,
  realtimeTokenResponseSchema,
  realtimeUserSchema,
  treeChangedSchema,
  treeSubscribeAckSchema,
  presenceUpdateAckSchema,
  projectPresenceSchema,
  userColor,
  type ProjectPresence,
  type TreeItem,
} from "@collab/shared";
import { signRealtimeToken } from "@collab/shared/realtime-token";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  type AuthorizedScope,
} from "@hocuspocus/provider";
import { io, type Socket } from "socket.io-client";
import * as Y from "yjs";

type Method = "GET" | "POST" | "PATCH" | "DELETE";
type RequestOptions = { method?: Method; body?: unknown; origin?: string };
type ApiResult = { status: number; headers: Headers; body: unknown };
type TokenResponse = ReturnType<typeof realtimeTokenResponseSchema.parse>;
type TreeChanged = ReturnType<typeof treeChangedSchema.parse>;
interface ServerEvents {
  "presence:changed": (event: unknown) => void;
  "tree:changed": (event: unknown) => void;
}
interface ClientEvents {
  "presence:update": (
    input: unknown,
    acknowledge: (result: unknown) => void,
  ) => void;
  "tree:subscribe": (
    input: unknown,
    acknowledge: (result: unknown) => void,
  ) => void;
}
type TreeSocket = Socket<ServerEvents, ClientEvents>;
type SocketProbe = {
  presence?: ProjectPresence;
  socket: TreeSocket;
  events: TreeChanged[];
  error: boolean;
};
type YjsProbe = {
  document: Y.Doc;
  provider: HocuspocusProvider;
  websocket: HocuspocusProviderWebsocket;
  failed: boolean;
  closed: boolean;
  destroyed: boolean;
  scope: AuthorizedScope | undefined;
};

const baseUrl = new URL(process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000")
  .origin;
const database = getDatabase();
const checkCode = process.argv.includes("--phase5");
const checkPresence = process.argv.includes("--phase4") || checkCode;
const runId = randomUUID();
const emailPrefix = `phase3-${runId}`;
const password = `Phase3-${randomBytes(24).toString("hex")}`;
const identities = [
  "owner",
  "editorA",
  "editorB",
  "viewer",
  "outsider",
] as const;
type Identity = (typeof identities)[number];
const emails = identities.map((name) =>
  `${emailPrefix}-${name}@example.test`.toLowerCase(),
);
const clients = new Map<Identity, HttpClient>();
const userIds = new Map<Identity, string>();
const sessionIds = new Map<Identity, string>();
const projectIds = new Set<string>();
const socketProbes = new Set<SocketProbe>();
const yjsProbes = new Set<YjsProbe>();
let cleanupAllowed = false;

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
      const retryAfter = Number(
        result.headers.get("x-retry-after") ??
          result.headers.get("retry-after"),
      );
      assert.ok(
        Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter <= 45,
        "Auth retry delay must be bounded",
      );
      console.log(
        `WAIT authentication rate limit: ${Math.ceil(retryAfter)} seconds`,
      );
      await delay(Math.ceil(retryAfter * 1000) + 100);
    }
    throw new Error("Authentication retries exceeded their bound");
  }

  private async requestOnce(
    path: string,
    options: RequestOptions,
  ): Promise<ApiResult> {
    const method = options.method ?? "GET";
    const headers = new Headers();
    if (this.cookies.size > 0)
      headers.set(
        "Cookie",
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    if (method !== "GET") {
      headers.set("Origin", options.origin ?? baseUrl);
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
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
    const isJson = response.headers
      .get("content-type")
      ?.includes("application/json");
    const body: unknown = isJson ? await response.json() : undefined;
    if (!isJson) await response.body?.cancel();
    return { status: response.status, headers: response.headers, body };
  }
}

function client(name: Identity): HttpClient {
  const value = clients.get(name);
  assert.ok(value, "Test identity must exist");
  return value;
}

function identity(name: Identity) {
  const userId = userIds.get(name);
  const sessionId = sessionIds.get(name);
  assert.ok(userId && sessionId, "Authenticated test identity must exist");
  return { userId, sessionId };
}

function expectStatus(
  result: ApiResult,
  expected: number,
  label: string,
): unknown {
  assert.equal(result.status, expected, `${label}: unexpected HTTP status`);
  return result.body;
}

async function expectError(
  client: HttpClient,
  path: string,
  status: number,
  label: string,
  options: RequestOptions = {},
) {
  apiErrorSchema.parse(
    expectStatus(await client.request(path, options), status, label),
  );
}

function pass(label: string): void {
  console.log(`PASS ${label}`);
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`${label}: timed out after ${timeoutMs} ms`);
}

async function createProject(name: Identity): Promise<string> {
  const { project } = createdProjectResponseSchema.parse(
    expectStatus(
      await client(name).request("/api/projects", {
        method: "POST",
        body: { name: `Phase 3 smoke ${name} ${runId}` },
      }),
      201,
      "project creation",
    ),
  );
  projectIds.add(project.id);
  return project.id;
}

async function createItem(
  projectId: string,
  title: string,
  type: "PAGE" | "FOLDER" = "PAGE",
  parentId: string | null = null,
): Promise<TreeItem> {
  const result = itemResponseSchema.parse(
    expectStatus(
      await client("owner").request(`/api/projects/${projectId}/items`, {
        method: "POST",
        body: { type, title, parentId },
      }),
      201,
      "item creation",
    ),
  );
  assert.equal(
    result.notificationPending,
    false,
    "Running relay must deliver tree notification",
  );
  return result.item;
}

async function items(projectId: string): Promise<TreeItem[]> {
  return itemsResponseSchema.parse(
    expectStatus(
      await client("owner").request(`/api/projects/${projectId}/items`),
      200,
      "tree read",
    ),
  ).items;
}

function assertOrders(tree: TreeItem[]): void {
  const groups = new Map<string | null, TreeItem[]>();
  for (const item of tree) {
    const siblings = groups.get(item.parentId) ?? [];
    siblings.push(item);
    groups.set(item.parentId, siblings);
  }
  for (const siblings of groups.values()) {
    assert.deepEqual(
      siblings.map((item) => item.order).sort((left, right) => left - right),
      siblings.map((_, index) => index),
      "Sibling orders must be contiguous and unique",
    );
  }
}

async function token(
  name: Identity,
  projectId: string,
): Promise<TokenResponse> {
  return realtimeTokenResponseSchema.parse(
    expectStatus(
      await client(name).request("/api/realtime-token", {
        method: "POST",
        body: { projectId },
      }),
      200,
      "realtime token issuance",
    ),
  );
}

function createSocket(token: TokenResponse): SocketProbe {
  const socket: TreeSocket = io(token.url, {
    auth: { token: token.token },
    autoConnect: false,
    reconnection: false,
    timeout: 5000,
    transports: ["websocket"],
  });
  const probe: SocketProbe = { socket, events: [], error: false };
  socket.on("tree:changed", (event) =>
    probe.events.push(treeChangedSchema.parse(event)),
  );
  socket.on("presence:changed", (event) => {
    probe.presence = projectPresenceSchema.parse(event);
  });
  socket.on("connect_error", () => {
    probe.error = true;
  });
  socketProbes.add(probe);
  socket.connect();
  return probe;
}

async function subscribe(
  probe: SocketProbe,
  projectId: string,
  allowed = true,
): Promise<void> {
  const result = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Tree subscription acknowledgement timed out")),
      5000,
    );
    probe.socket.emit("tree:subscribe", { projectId }, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  assert.equal(
    treeSubscribeAckSchema.parse(result).ok,
    allowed,
    "Subscription must follow project authorization",
  );
}

async function allowedSocket(
  token: TokenResponse,
  projectId: string,
): Promise<SocketProbe> {
  const probe = createSocket(token);
  await waitUntil(
    () => probe.socket.connected || probe.error,
    "Socket connection",
  );
  assert.equal(probe.error, false, "Authorized socket must connect");
  await subscribe(probe, projectId);
  return probe;
}

async function deniedSocket(token: TokenResponse): Promise<void> {
  const probe = createSocket(token);
  try {
    await waitUntil(
      () => probe.socket.connected || probe.error,
      "Denied socket handshake",
    );
    assert.equal(
      probe.socket.connected,
      false,
      "Unauthorized socket must not connect",
    );
    assert.equal(probe.error, true);
  } finally {
    probe.socket.disconnect();
  }
}

function createYjs(token: TokenResponse, itemId: string): YjsProbe {
  const document = new Y.Doc();
  const websocket = new HocuspocusProviderWebsocket({
    url: new URL("/yjs", token.url).toString().replace(/^http/, "ws"),
    autoConnect: false,
    WebSocketPolyfill: globalThis.WebSocket,
    maxAttempts: 1,
    timeout: 5000,
    messageReconnectTimeout: 30_000,
  });
  const probe: YjsProbe = {
    document,
    websocket,
    provider: new HocuspocusProvider({
      websocketProvider: websocket,
      document,
      name: `item:${itemId}`,
      token: token.token,
      onAuthenticated: ({ scope }) => {
        probe.scope = scope;
      },
      onAuthenticationFailed: () => {
        probe.failed = true;
      },
      onClose: () => {
        probe.closed = true;
      },
    }),
    failed: false,
    closed: false,
    destroyed: false,
    scope: undefined,
  };
  yjsProbes.add(probe);
  probe.provider.attach();
  void websocket.connect();
  return probe;
}

function destroyYjs(probe: YjsProbe): void {
  if (probe.destroyed) return;
  probe.destroyed = true;
  probe.provider.destroy();
  probe.websocket.destroy();
  probe.document.destroy();
}

async function allowedYjs(
  token: TokenResponse,
  itemId: string,
  scope: AuthorizedScope = "read-write",
): Promise<YjsProbe> {
  const probe = createYjs(token, itemId);
  await waitUntil(
    () => probe.provider.isSynced || probe.failed || probe.closed,
    "Yjs initial sync",
  );
  assert.equal(
    probe.failed,
    false,
    "Authorized Yjs connection must authenticate",
  );
  assert.equal(
    probe.provider.isSynced,
    true,
    "Authorized Yjs connection must sync",
  );
  assert.equal(probe.scope, scope, "Yjs scope must follow fresh database role");
  return probe;
}

async function deniedYjs(token: TokenResponse, itemId: string): Promise<void> {
  const probe = createYjs(token, itemId);
  try {
    await waitUntil(
      () => probe.failed || probe.closed || probe.provider.isSynced,
      "Denied Yjs authentication",
    );
    assert.equal(
      probe.provider.isSynced,
      false,
      "Unauthorized Yjs connection must not receive the page",
    );
    assert.ok(
      probe.failed || probe.closed,
      "Unauthorized Yjs connection must be denied",
    );
  } finally {
    destroyYjs(probe);
  }
}

function xmlText(document: Y.Doc): Y.XmlText {
  const text = document.getXmlFragment("phase3-smoke").firstChild;
  assert.ok(text instanceof Y.XmlText, "XML text fixture must exist");
  return text;
}

async function updatePresence(
  probe: SocketProbe,
  input: unknown,
  allowed = true,
) {
  const result = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Presence acknowledgement timed out")),
      5000,
    );
    probe.socket.emit("presence:update", input, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  assert.equal(presenceUpdateAckSchema.parse(result).ok, allowed);
}

async function verifyCode(
  projectId: string,
  pageId: string,
  sockets: SocketProbe[],
) {
  const collection = `/api/projects/${projectId}/items`;
  const { item: code } = itemResponseSchema.parse(
    expectStatus(
      await client("owner").request(collection, {
        method: "POST",
        body: { type: "CODE", title: "main.js", parentId: null },
      }),
      201,
      "Create code file",
    ),
  );
  assert.equal(code.language, "javascript");
  assert.equal(
    (await database.item.findUniqueOrThrow({ where: { id: code.id } }))
      .language,
    "javascript",
  );
  const path = `${collection}/${code.id}`;
  for (const name of ["owner", "editorA", "viewer"] as const)
    assert.equal(
      itemResponseSchema.parse(
        expectStatus(
          await client(name).request(path),
          200,
          "Member reads code",
        ),
      ).item.id,
      code.id,
    );
  await expectError(client("outsider"), path, 403, "Outsider cannot read code");
  await expectError(
    client("viewer"),
    collection,
    403,
    "Viewer cannot create code",
    { method: "POST", body: { type: "CODE", title: "forbidden.py" } },
  );
  await expectError(
    client("viewer"),
    path,
    403,
    "Viewer cannot change language",
    { method: "PATCH", body: { action: "language", language: "python" } },
  );
  await expectError(
    client("owner"),
    path,
    400,
    "Unsupported language rejected",
    {
      method: "PATCH",
      body: { action: "language", language: "invented-language" },
    },
  );
  await expectError(
    client("owner"),
    `${collection}/${pageId}`,
    400,
    "Page cannot receive language",
    { method: "PATCH", body: { action: "language", language: "python" } },
  );
  await expectError(
    client("owner"),
    collection,
    400,
    "Page creation cannot inject language",
    {
      method: "POST",
      body: { type: "PAGE", title: "Invalid", language: "python" },
    },
  );
  const counts = sockets.map((probe) => probe.events.length);
  const changed = itemResponseSchema.parse(
    expectStatus(
      await client("editorA").request(path, {
        method: "PATCH",
        body: { action: "language", language: "python" },
      }),
      200,
      "Editor changes language",
    ),
  );
  assert.equal(changed.item.language, "python");
  assert.equal(changed.notificationPending, false);
  await waitUntil(
    () => sockets.every((probe, index) => probe.events.length > counts[index]!),
    "Language broadcasts",
  );
  assert.equal(
    (await items(projectId)).find((item) => item.id === code.id)?.language,
    "python",
  );
  await updatePresence(sockets[0]!, { projectId, itemId: code.id });
  await waitUntil(
    () =>
      sockets[0]!.presence?.users.some((member) =>
        member.itemIds.includes(code.id),
      ) === true,
    "Code presence",
  );
  pass(
    "Code creation, persisted language changes and presence work; viewers, outsiders and invalid item/language inputs are rejected",
  );
  const [left, right, reader] = await Promise.all([
    allowedYjs(await token("owner", projectId), code.id),
    allowedYjs(await token("editorA", projectId), code.id),
    allowedYjs(await token("viewer", projectId), code.id, "readonly"),
  ]);
  left.document.getText("code").insert(0, "# AlphaCode\n");
  right.document.getText("code").insert(0, "# BravoCode\n");
  await waitUntil(() => {
    const values = [left, right, reader].map((probe) =>
      probe.document.getText("code").toString(),
    );
    return (
      new Set(values).size === 1 &&
      values.every(
        (value) => value.includes("AlphaCode") && value.includes("BravoCode"),
      )
    );
  }, "Code convergence");
  const expected = left.document.getText("code").toString();
  reader.document.getText("code").insert(0, "FORBIDDEN_VIEWER_CODE");
  await delay(500);
  assert.equal(left.document.getText("code").toString(), expected);
  assert.equal(right.document.getText("code").toString(), expected);
  left.provider.awareness?.setLocalStateField("user", {
    name: "Forged code user",
    color: "#000000",
  });
  left.provider.awareness?.setLocalStateField("selection", {
    anchor: Y.createRelativePositionFromTypeIndex(
      left.document.getText("code"),
      0,
    ),
    head: Y.createRelativePositionFromTypeIndex(
      left.document.getText("code"),
      5,
    ),
  });
  await waitUntil(() => {
    const parsed = awarenessStateSchema.safeParse(
      right.provider.awareness?.getStates().get(left.document.clientID),
    );
    return (
      parsed.success &&
      parsed.data.user.id === identity("owner").userId &&
      parsed.data.selection != null
    );
  }, "Trusted Monaco selection");
  const malformed = await allowedYjs(
    await token("viewer", projectId),
    code.id,
    "readonly",
  );
  malformed.provider.awareness?.setLocalStateField("selection", {
    anchor: [],
    head: true,
  });
  await waitUntil(() => malformed.closed, "Malformed code selection rejected");
  assert.equal(
    right.provider.awareness?.getStates().has(malformed.document.clientID),
    false,
  );
  destroyYjs(malformed);
  pass(
    "Two code writers converge; viewer writes and malformed selections are rejected; cursor identities come from the server",
  );
  for (const probe of [left, right, reader]) destroyYjs(probe);
  await waitUntil(async () => {
    const saved = await database.item.findUniqueOrThrow({
      where: { id: code.id },
    });
    if (!saved.yjsState) return false;
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, saved.yjsState);
      return doc.getText("code").toString() === expected;
    } finally {
      doc.destroy();
    }
  }, "Code persistence");
  const restored = await allowedYjs(await token("owner", projectId), code.id);
  assert.equal(restored.document.getText("code").toString(), expected);
  destroyYjs(restored);
  const folder = await createItem(projectId, "Code folder", "FOLDER");
  expectStatus(
    await client("owner").request(path, {
      method: "PATCH",
      body: { action: "move", parentId: folder.id, index: 0 },
    }),
    200,
    "Move code",
  );
  expectStatus(
    await client("owner").request(path, {
      method: "PATCH",
      body: { action: "rename", title: "renamed.py" },
    }),
    200,
    "Rename code",
  );
  const removed = deleteItemsResponseSchema.parse(
    expectStatus(
      await client("owner").request(`${collection}/${folder.id}`, {
        method: "DELETE",
        body: {},
      }),
      200,
      "Delete code folder",
    ),
  );
  assert.ok(removed.deletedIds.includes(code.id));
  await deniedYjs(await token("owner", projectId), code.id);
  pass(
    "Code persists into fresh clients, moves and renames in the tree, and loses document access after subtree deletion",
  );
}

async function verifyPresence(
  projectId: string,
  otherProjectId: string,
  pageId: string,
  sockets: SocketProbe[],
) {
  const owner = sockets[0]!;
  const editor = sockets[1]!;
  const viewer = sockets[2]!;
  await updatePresence(owner, { projectId, itemId: pageId });
  await updatePresence(editor, { projectId, itemId: pageId });
  await updatePresence(viewer, { projectId, itemId: null });
  await waitUntil(
    () => sockets.every((probe) => probe.presence?.users.length === 3),
    "Project-wide presence including overview viewer",
  );
  for (const member of owner.presence!.users) {
    const stored = await database.user.findUniqueOrThrow({
      where: { id: member.user.id },
    });
    assert.equal(member.user.name, stored.name);
    assert.equal(member.user.color, userColor(stored.id));
    assert.equal(member.user.image, stored.image);
  }
  const { item: foreignPage } = itemResponseSchema.parse(
    expectStatus(
      await client("outsider").request(
        `/api/projects/${otherProjectId}/items`,
        {
          method: "POST",
          body: {
            type: "PAGE",
            title: "Foreign presence page",
            parentId: null,
          },
        },
      ),
      201,
      "Foreign project owner creates its own page",
    ),
  );
  const folder = await createItem(projectId, "Presence folder", "FOLDER");
  await updatePresence(
    owner,
    { projectId: otherProjectId, itemId: null },
    false,
  );
  await updatePresence(owner, { projectId, itemId: foreignPage.id }, false);
  await updatePresence(owner, { projectId, itemId: folder.id }, false);
  await updatePresence(
    owner,
    { projectId, itemId: pageId, user: { name: "Forged identity" } },
    false,
  );
  await updatePresence(owner, { projectId, itemId: "invalid" }, false);
  pass(
    "Presence uses database identities; forged identity, foreign project/page, folder and malformed locations are refused",
  );

  const secondPage = await createItem(projectId, "Second presence page");
  const otherTab = await allowedSocket(
    await token("owner", projectId),
    projectId,
  );
  await updatePresence(otherTab, { projectId, itemId: secondPage.id });
  await waitUntil(
    () =>
      owner.presence?.users.find(
        (member) => member.user.id === identity("owner").userId,
      )?.itemIds.length === 2,
    "Multiple owner tabs aggregated",
  );
  assert.equal(owner.presence!.users.length, 3);
  await updatePresence(otherTab, { projectId, itemId: pageId });
  await waitUntil(
    () =>
      owner.presence?.users.find(
        (member) => member.user.id === identity("owner").userId,
      )?.itemIds.length === 1,
    "Duplicate page locations deduplicated",
  );
  await updatePresence(otherTab, { projectId, itemId: secondPage.id });
  otherTab.socket.disconnect();
  await waitUntil(
    () =>
      owner.presence?.users.find(
        (member) => member.user.id === identity("owner").userId,
      )?.itemIds.length === 1,
    "Closed tab location removed",
    5000,
  );
  assert.equal(owner.presence!.users.length, 3);
  pass(
    "One entry per user aggregates multiple pages, deduplicates matching tabs, and removes a closed tab while retaining the user's other tab",
  );

  await updatePresence(editor, { projectId, itemId: secondPage.id });
  await waitUntil(
    () =>
      owner.presence?.users
        .find((member) => member.user.id === identity("editorA").userId)
        ?.itemIds.includes(secondPage.id) === true,
    "Page movement broadcast",
  );
  expectStatus(
    await client("owner").request(
      `/api/projects/${projectId}/items/${secondPage.id}`,
      { method: "DELETE", body: {} },
    ),
    200,
    "Delete viewed page",
  );
  await waitUntil(
    () =>
      owner.presence?.users.find(
        (member) => member.user.id === identity("editorA").userId,
      )?.viewingOverview === true,
    "Deleted page presence cleared",
    5000,
  );
  editor.socket.disconnect();
  await waitUntil(
    () => owner.presence?.users.length === 2,
    "Last tab removes user",
    5000,
  );
  sockets[1] = await allowedSocket(
    await token("editorA", projectId),
    projectId,
  );
  await updatePresence(sockets[1]!, { projectId, itemId: pageId });
  await waitUntil(
    () => owner.presence?.users.length === 3,
    "Reconnect restores presence",
  );
  pass(
    "Page switches and deleted-page locations update live; closing the last tab removes the user within five seconds and reconnect restores them",
  );

  await database.projectMember.delete({
    where: {
      projectId_userId: { projectId, userId: identity("viewer").userId },
    },
  });
  await waitUntil(
    () => !viewer.socket.connected && owner.presence?.users.length === 2,
    "Idle revoked member removed",
    5000,
  );
  await database.projectMember.create({
    data: { projectId, userId: identity("viewer").userId, role: "VIEWER" },
  });
  sockets[2] = await allowedSocket(await token("viewer", projectId), projectId);
  await updatePresence(sockets[2]!, { projectId, itemId: pageId });
  await waitUntil(
    () => owner.presence?.users.length === 3,
    "Reauthorized viewer returns",
  );
  pass(
    "Idle membership revocation disconnects the viewer and removes their presence within five seconds without a client event",
  );

  const expired = await allowedSocket(
    await token("editorB", projectId),
    projectId,
  );
  await updatePresence(expired, { projectId, itemId: pageId });
  await waitUntil(
    () => owner.presence?.users.length === 4,
    "Session-expiry probe enters presence",
  );
  const session = await database.session.findUniqueOrThrow({
    where: { id: identity("editorB").sessionId },
  });
  try {
    await database.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await waitUntil(
      () => !expired.socket.connected && owner.presence?.users.length === 3,
      "Idle expired session removed",
      5000,
    );
  } finally {
    await database.session.update({
      where: { id: session.id },
      data: { expiresAt: session.expiresAt },
    });
  }
  pass(
    "Idle session expiry removes presence within five seconds without exposing further snapshots",
  );
}

async function run(): Promise<void> {
  assert.equal(
    await database.user.count({ where: { email: { in: emails } } }),
    0,
    "Generated accounts must not already exist",
  );
  cleanupAllowed = true;
  for (const name of identities) {
    const member = new HttpClient();
    clients.set(name, member);
    const email = `${emailPrefix}-${name}@example.test`.toLowerCase();
    expectStatus(
      await member.request("/api/auth/sign-up/email", {
        method: "POST",
        body: { name: `Phase 3 ${name}`, email, password },
      }),
      200,
      "account creation",
    );
    const user = await database.user.findUniqueOrThrow({ where: { email } });
    const session = await database.session.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    userIds.set(name, user.id);
    sessionIds.set(name, session.id);
  }
  const projectId = await createProject("owner");
  const otherProjectId = await createProject("outsider");
  const collection = `/api/projects/${projectId}/items`;
  for (const role of ["EDITOR", "VIEWER"] as const) {
    const { invite } = inviteResponseSchema.parse(
      expectStatus(
        await client("owner").request(`/api/projects/${projectId}/invites`, {
          method: "POST",
          body: { role, expiresInDays: 1 },
        }),
        201,
        "invite creation",
      ),
    );
    for (const name of role === "EDITOR"
      ? (["editorA", "editorB"] as const)
      : (["viewer"] as const)) {
      const joined = joinInviteResponseSchema.parse(
        expectStatus(
          await client(name).request(`/api/invites/${invite.code}/join`, {
            method: "POST",
            body: {},
          }),
          200,
          "invite join",
        ),
      );
      assert.equal(joined.role, role);
    }
  }
  const anonymous = new HttpClient();
  for (const [member, expected] of [
    [anonymous, 401],
    [client("outsider"), 403],
  ] as const) {
    await expectError(member, collection, expected, "Unauthorized tree read");
    await expectError(
      member,
      collection,
      expected,
      "Unauthorized tree create",
      {
        method: "POST",
        body: { type: "PAGE", title: "Forbidden", parentId: null },
      },
    );
    await expectError(
      member,
      "/api/realtime-token",
      expected,
      "Unauthorized realtime token",
      { method: "POST", body: { projectId } },
    );
  }
  await expectError(
    client("owner"),
    "/api/realtime-token",
    400,
    "Token role injection",
    { method: "POST", body: { projectId, role: "OWNER" } },
  );
  const tokens = new Map<Identity, TokenResponse>();
  for (const name of ["owner", "editorA", "editorB", "viewer"] as const)
    tokens.set(name, await token(name, projectId));
  const getToken = (name: Identity): TokenResponse => {
    const value = tokens.get(name);
    assert.ok(value);
    return value;
  };
  const sockets = await Promise.all(
    ["owner", "editorA", "viewer"].map((name) =>
      allowedSocket(getToken(name as Identity), projectId),
    ),
  );
  await subscribe(sockets[0]!, otherProjectId, false);
  const counts = sockets.map((probe) => probe.events.length);
  const folder = await createItem(projectId, "Folder", "FOLDER");
  await waitUntil(
    () => sockets.every((probe, index) => probe.events.length > counts[index]!),
    "Tree event reaches three subscribed clients",
  );
  for (const probe of sockets)
    assert.equal(probe.events.at(-1)?.projectId, projectId);
  pass(
    "Authenticated project-scoped tree subscriptions broadcast committed changes to three clients",
  );

  const page = await createItem(
    projectId,
    "Collaborative page",
    "PAGE",
    folder.id,
  );
  const nested = await createItem(projectId, "Nested", "FOLDER", folder.id);
  const leaf = await createItem(projectId, "Leaf", "PAGE", nested.id);
  const tree = itemsResponseSchema.parse(
    expectStatus(
      await client("viewer").request(collection),
      200,
      "Viewer reads tree",
    ),
  ).items;
  assert.equal(tree.length, 4);
  assert.ok(
    tree.every((item) => !Object.hasOwn(item, "yjsState")),
    "Tree DTO must not expose document bytes",
  );
  for (const [path, method, body] of [
    [collection, "POST", { type: "PAGE", title: "Forbidden", parentId: null }],
    [
      `${collection}/${page.id}`,
      "PATCH",
      { action: "rename", title: "Forbidden" },
    ],
    [
      `${collection}/${page.id}`,
      "PATCH",
      { action: "move", parentId: null, index: 0 },
    ],
    [`${collection}/${folder.id}`, "DELETE", {}],
  ] as const) {
    await expectError(client("viewer"), path, 403, "Viewer direct write", {
      method,
      body,
    });
  }
  await expectError(
    client("owner"),
    collection,
    400,
    "Create unsupported item type",
    { method: "POST", body: { type: "SCRIPT", title: "Code", parentId: null } },
  );
  await expectError(client("owner"), collection, 400, "Create extra role", {
    method: "POST",
    body: { type: "PAGE", title: "Injected", role: "OWNER", parentId: null },
  });
  await expectError(client("owner"), collection, 403, "Cross origin create", {
    method: "POST",
    origin: "https://other.example.test",
    body: { type: "PAGE", title: "Injected", parentId: null },
  });
  await expectError(client("owner"), collection, 400, "Non-folder parent", {
    method: "POST",
    body: { type: "PAGE", title: "Injected", parentId: page.id },
  });
  await expectError(
    client("owner"),
    `${collection}?unknown=1`,
    400,
    "Unexpected query",
  );
  const renamed = itemResponseSchema.parse(
    expectStatus(
      await client("editorA").request(`${collection}/${page.id}`, {
        method: "PATCH",
        body: { action: "rename", title: "Renamed collaborative page" },
      }),
      200,
      "Editor rename",
    ),
  );
  assert.equal(renamed.item.title, "Renamed collaborative page");
  assert.equal(renamed.notificationPending, false);
  for (const [parentId, label] of [
    [folder.id, "Self-parent"],
    [nested.id, "Cycle"],
  ] as const)
    await expectError(
      client("owner"),
      `${collection}/${folder.id}`,
      400,
      label,
      { method: "PATCH", body: { action: "move", parentId, index: 0 } },
    );
  await expectError(
    client("owner"),
    `${collection}/${page.id}`,
    400,
    "Out-of-range move",
    { method: "PATCH", body: { action: "move", parentId: null, index: 99 } },
  );
  const otherItem = await database.item.create({
    data: {
      projectId: otherProjectId,
      type: "FOLDER",
      title: "Other project folder",
    },
  });
  await expectError(
    client("owner"),
    `${collection}/${page.id}`,
    400,
    "Cross project parent",
    {
      method: "PATCH",
      body: { action: "move", parentId: otherItem.id, index: 0 },
    },
  );
  for (const method of ["GET", "PATCH", "DELETE"] as const)
    await expectError(
      client("owner"),
      `${collection}/${otherItem.id}`,
      404,
      "Cross project item",
      {
        method,
        ...(method === "PATCH"
          ? { body: { action: "rename", title: "Forbidden" } }
          : method === "DELETE"
            ? { body: {} }
            : {}),
      },
    );
  const moved = itemResponseSchema.parse(
    expectStatus(
      await client("editorA").request(`${collection}/${page.id}`, {
        method: "PATCH",
        body: { action: "move", parentId: null, index: 0 },
      }),
      200,
      "Editor moves item",
    ),
  );
  assert.equal(moved.item.parentId, null);
  assert.equal(moved.item.order, 0);
  assertOrders(await items(projectId));
  pass(
    "Create, rename, move and viewer write checks enforce strict input, project scope and acyclic folders",
  );

  const concurrentlyCreated = await Promise.all(
    ["Concurrent A", "Concurrent B", "Concurrent C"].map((title) =>
      createItem(projectId, title),
    ),
  );
  assert.equal(new Set(concurrentlyCreated.map((item) => item.order)).size, 3);
  const left = await createItem(projectId, "Concurrent left", "FOLDER");
  const right = await createItem(projectId, "Concurrent right", "FOLDER");
  const cycleResults = await Promise.all([
    client("owner").request(`${collection}/${left.id}`, {
      method: "PATCH",
      body: { action: "move", parentId: right.id, index: 0 },
    }),
    client("editorA").request(`${collection}/${right.id}`, {
      method: "PATCH",
      body: { action: "move", parentId: left.id, index: 0 },
    }),
  ]);
  assert.deepEqual(
    cycleResults.map((result) => result.status).sort(),
    [200, 400],
    "Serialized concurrent moves must not create a cycle",
  );
  assertOrders(await items(projectId));
  const deleted = deleteItemsResponseSchema.parse(
    expectStatus(
      await client("editorA").request(`${collection}/${folder.id}`, {
        method: "DELETE",
        body: {},
      }),
      200,
      "Delete folder subtree",
    ),
  );
  assert.deepEqual(
    new Set(deleted.deletedIds),
    new Set([folder.id, nested.id, leaf.id]),
  );
  assert.equal(
    await database.item.count({ where: { id: { in: deleted.deletedIds } } }),
    0,
  );
  assert.ok(
    (await items(projectId)).some((item) => item.id === page.id),
    "Moved page must survive deletion of its old folder",
  );
  assertOrders(await items(projectId));
  pass(
    "Concurrent tree writes preserve contiguous orders, reject competing cycles and delete subtrees atomically",
  );

  const signingSecret = process.env.REALTIME_TOKEN_SECRET;
  assert.ok(
    signingSecret && signingSecret.length >= 32,
    "Realtime signing secret is required for security fixtures",
  );
  const forged = {
    ...getToken("owner"),
    token: `${getToken("owner").token.slice(0, -8)}AAAAAAAA`,
  };
  const expired = {
    ...getToken("owner"),
    token: signRealtimeToken(
      { ...identity("owner"), projectId, role: "OWNER" },
      { secret: signingSecret, issuer: baseUrl, now: Date.now() - 360_000 },
    ).token,
  };
  const outsider = {
    ...getToken("owner"),
    token: signRealtimeToken(
      { ...identity("outsider"), projectId, role: "OWNER" },
      { secret: signingSecret, issuer: baseUrl },
    ).token,
  };
  for (const invalid of [forged, expired, outsider]) {
    await deniedSocket(invalid);
    await deniedYjs(invalid, page.id);
  }
  await deniedYjs(getToken("owner"), otherItem.id);
  pass(
    "Both realtime transports reject forged, expired and outsider tokens plus cross-project documents",
  );

  const editors = await Promise.all(
    ["owner", "editorA", "editorB"].map((name) =>
      allowedYjs(getToken(name as Identity), page.id),
    ),
  );
  const reader = await allowedYjs(getToken("viewer"), page.id, "readonly");
  const initial = editors[0]!;
  initial.document.transact(() => {
    initial.document.getText("phase3-smoke-text").insert(0, "seed");
    const text = new Y.XmlText();
    initial.document.getXmlFragment("phase3-smoke").insert(0, [text]);
    text.insert(0, "seed");
  });
  await waitUntil(
    () =>
      [...editors, reader].every(
        (probe) =>
          probe.document.getText("phase3-smoke-text").toString() === "seed" &&
          probe.document.getXmlFragment("phase3-smoke").toString() === "seed",
      ),
    "Initial document distribution",
  );
  for (const [index, probe] of editors.entries()) {
    const marker = `[${index}]`;
    probe.document.transact(() => {
      const text = probe.document.getText("phase3-smoke-text");
      text.insert(2, marker);
      text.delete(0, 1);
      const xml = xmlText(probe.document);
      xml.insert(2, marker);
      xml.format(0, 1, { bold: true });
    });
  }
  await waitUntil(() => {
    const text = initial.document.getText("phase3-smoke-text").toString();
    const xml = initial.document.getXmlFragment("phase3-smoke").toString();
    return (
      ["[0]", "[1]", "[2]"].every(
        (marker) => text.includes(marker) && xml.includes(marker),
      ) &&
      [...editors, reader].every(
        (probe) =>
          probe.document.getText("phase3-smoke-text").toString() === text &&
          probe.document.getXmlFragment("phase3-smoke").toString() === xml,
      )
    );
  }, "Three-client concurrent text and XML convergence");
  const expectedText = initial.document.getText("phase3-smoke-text").toString();
  const expectedXml = initial.document
    .getXmlFragment("phase3-smoke")
    .toString();
  for (const probe of editors)
    assert.deepEqual(
      Y.encodeStateVector(probe.document),
      Y.encodeStateVector(initial.document),
      "All editor state vectors must converge",
    );
  reader.document.getText("phase3-smoke-text").insert(0, "FORBIDDEN_VIEWER");
  await delay(600);
  assert.ok(
    editors.every(
      (probe) =>
        !probe.document
          .getText("phase3-smoke-text")
          .toString()
          .includes("FORBIDDEN_VIEWER"),
    ),
    "Viewer local updates must not enter shared state",
  );
  pass(
    "Three concurrent editors converge on text and XML; a malicious viewer update is not relayed",
  );

  initial.provider.awareness?.setLocalStateField("user", {
    id: identity("outsider").userId,
    name: "Spoofed identity",
    color: "#000000",
    image: null,
  });
  await waitUntil(() => {
    const state: unknown = editors[1]!.provider.awareness
      ?.getStates()
      .get(initial.document.clientID);
    if (!state || typeof state !== "object" || !("user" in state)) return false;
    const user = realtimeUserSchema.safeParse(state.user);
    return (
      user.success &&
      user.data.id === identity("owner").userId &&
      user.data.name === "Phase 3 owner"
    );
  }, "Server-stamped awareness identity");
  pass(
    "Awareness identity comes from the authenticated account rather than client-supplied names",
  );

  const cursor = {
    anchor: Y.createRelativePositionFromTypeIndex(
      xmlText(initial.document),
      0,
      -1,
    ),
    head: Y.createRelativePositionFromTypeIndex(xmlText(initial.document), 1),
  };
  const authenticatedUser = {
    id: identity("owner").userId,
    name: "Phase 3 owner",
    image: null,
    color: "#047857",
  };
  awarenessStateSchema.parse({ user: authenticatedUser, cursor });
  awarenessStateSchema.parse({
    user: authenticatedUser,
    cursor: {
      anchor: Y.relativePositionToJSON(cursor.anchor),
      head: Y.relativePositionToJSON(cursor.head),
    },
  });
  initial.provider.awareness?.setLocalStateField("cursor", cursor);
  await waitUntil(() => {
    const state = awarenessStateSchema.safeParse(
      editors[1]!.provider.awareness
        ?.getStates()
        .get(initial.document.clientID),
    );
    return (
      state.success &&
      state.data.cursor != null &&
      Y.compareRelativePositions(
        Y.createRelativePositionFromJSON(state.data.cursor.anchor),
        cursor.anchor,
      ) &&
      Y.compareRelativePositions(
        Y.createRelativePositionFromJSON(state.data.cursor.head),
        cursor.head,
      )
    );
  }, "Valid generated Yjs cursor forwarding");

  const malformedCursors: unknown[] = [
    true,
    [],
    { anchor: null, head: null },
    { anchor: {}, head: {} },
    { anchor: { tname: "phase3-smoke" } },
    {
      anchor: { type: { client: 0x100000000, clock: 0 } },
      head: cursor.head,
    },
    {
      anchor: { item: { client: initial.document.clientID, clock: -1 } },
      head: cursor.head,
    },
    {
      anchor: { tname: "phase3-smoke", assoc: "left" },
      head: cursor.head,
    },
  ];
  for (const malformedCursor of malformedCursors) {
    assert.equal(
      awarenessStateSchema.safeParse({
        user: authenticatedUser,
        cursor: malformedCursor,
      }).success,
      false,
      "Shared schema must reject malformed cursor states",
    );
    const malformed = await allowedYjs(getToken("viewer"), page.id, "readonly");
    try {
      malformed.provider.awareness?.setLocalStateField(
        "cursor",
        malformedCursor,
      );
      await waitUntil(
        () => malformed.closed,
        "Malformed awareness sender is disconnected",
      );
      assert.ok(
        editors.every(
          (probe) =>
            !probe.provider.awareness
              ?.getStates()
              .has(malformed.document.clientID),
        ),
        "Malformed awareness must not reach another editor",
      );
    } finally {
      destroyYjs(malformed);
    }
  }
  pass(
    "Generated Yjs cursor positions are forwarded; malformed viewer cursors are rejected before reaching peers",
  );

  for (const probe of [...editors, reader]) destroyYjs(probe);
  await waitUntil(async () => {
    const stored = await database.item.findUniqueOrThrow({
      where: { id: page.id },
      select: { yjsState: true },
    });
    if (!stored.yjsState) return false;
    const restored = new Y.Doc();
    try {
      Y.applyUpdate(restored, stored.yjsState);
      return (
        restored.getText("phase3-smoke-text").toString() === expectedText &&
        restored.getXmlFragment("phase3-smoke").toString() === expectedXml
      );
    } finally {
      restored.destroy();
    }
  }, "Persisted authoritative Yjs snapshot");
  await delay(200);
  const reloaded = await allowedYjs(getToken("owner"), page.id);
  assert.equal(
    reloaded.document.getText("phase3-smoke-text").toString(),
    expectedText,
  );
  assert.equal(
    reloaded.document.getXmlFragment("phase3-smoke").toString(),
    expectedXml,
  );
  pass(
    "After all document clients disconnect, PostgreSQL stores the converged snapshot and a fresh client reloads it",
  );

  if (checkCode) await verifyCode(projectId, page.id, sockets);
  if (checkPresence)
    await verifyPresence(projectId, otherProjectId, page.id, sockets);

  const downgraded = await allowedYjs(getToken("editorA"), page.id);
  const revoked = await allowedYjs(getToken("editorB"), page.id);
  const revokedSocket = await allowedSocket(getToken("editorB"), projectId);
  await database.projectMember.update({
    where: {
      projectId_userId: { projectId, userId: identity("editorA").userId },
    },
    data: { role: "VIEWER" },
  });
  downgraded.document
    .getText("phase3-smoke-text")
    .insert(0, "FORBIDDEN_DOWNGRADE");
  await delay(600);
  assert.equal(
    reloaded.document.getText("phase3-smoke-text").toString(),
    expectedText,
    "Active downgraded editor must immediately lose write permission",
  );
  await expectError(
    client("editorA"),
    `${collection}/${page.id}`,
    403,
    "Fresh downgraded tree role",
    {
      method: "PATCH",
      body: { action: "rename", title: "Forbidden downgrade" },
    },
  );
  const nowReadonly = await allowedYjs(
    getToken("editorA"),
    page.id,
    "readonly",
  );
  destroyYjs(nowReadonly);
  await database.session.update({
    where: { id: identity("editorB").sessionId },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  revoked.document
    .getText("phase3-smoke-text")
    .insert(0, "FORBIDDEN_REVOKED_SESSION");
  revokedSocket.socket.emit("tree:subscribe", { projectId }, () => {});
  await waitUntil(
    () => revoked.closed && !revokedSocket.socket.connected,
    "Active revoked sessions are disconnected",
  );
  assert.equal(
    reloaded.document.getText("phase3-smoke-text").toString(),
    expectedText,
  );
  await deniedSocket(getToken("editorB"));
  await deniedYjs(getToken("editorB"), page.id);
  const viewerSocket = sockets[2]!;
  const viewerEvents = viewerSocket.events.length;
  await database.projectMember.delete({
    where: {
      projectId_userId: { projectId, userId: identity("viewer").userId },
    },
  });
  expectStatus(
    await client("owner").request(`${collection}/${page.id}`, {
      method: "PATCH",
      body: { action: "rename", title: "Final smoke page" },
    }),
    200,
    "Mutation after member removal",
  );
  await waitUntil(
    () => !viewerSocket.socket.connected,
    "Removed member disconnects before receiving a tree event",
  );
  assert.equal(
    viewerSocket.events.length,
    viewerEvents,
    "Removed member must not receive outgoing tree events",
  );
  pass(
    "Active downgrades, revoked sessions and removed memberships are rechecked before writes and outgoing tree events",
  );

  destroyYjs(downgraded);
  destroyYjs(revoked);
  destroyYjs(reloaded);
}

async function cleanup(): Promise<void> {
  for (const probe of socketProbes) probe.socket.disconnect();
  for (const probe of yjsProbes) destroyYjs(probe);
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
  for (const project of projects) projectIds.add(project.id);
  await database.project.deleteMany({
    where: { id: { in: [...projectIds] }, ownerId: { in: userIds } },
  });
  await database.user.deleteMany({ where: { id: { in: userIds } } });
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
    pass(
      "Guarded cleanup removes only this run's accounts, projects and connections",
    );
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
else
  console.log(
    `Phase ${checkCode ? "5 code plus Phases 3/4" : checkPresence ? "4 presence plus Phase 3" : "3"} HTTP, Socket.IO and Yjs smoke checks passed.`,
  );
