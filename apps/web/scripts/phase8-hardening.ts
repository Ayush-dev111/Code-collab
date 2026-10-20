import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getDatabase } from "@collab/db";
import { consumeRateLimit, RateLimitError } from "@collab/server";
import {
  chatSendAckSchema,
  createdProjectResponseSchema,
  itemResponseSchema,
  realtimeTokenResponseSchema,
  safeLinkUrl,
} from "@collab/shared";
import { createClient } from "redis";
import { io, type Socket } from "socket.io-client";
import type { TestStack } from "./test-support/test-stack.ts";

export async function verifyHardening(stack: TestStack) {
  const database = getDatabase();
  const prefix = `phase8-${randomUUID()}`;
  const emails = ["owner", "viewer"].map(
    (role) => `${prefix}-${role}@example.test`,
  );
  const password = `Phase8-${randomBytes(24).toString("hex")}`;
  const projects: string[] = [];
  const keys = new Set<string>();
  const sockets: Socket[] = [];
  const previousRedis = process.env.REDIS_URL;
  process.env.REDIS_URL = stack.environment.REDIS_URL;
  const redis = createClient({
    url: stack.environment.REDIS_URL!,
    socket: { reconnectStrategy: false, connectTimeout: 1500 },
  });
  redis.on("error", () => undefined);
  class Client {
    cookies = new Map<string, string>();
    async request(
      path: string,
      body?: unknown,
      method = body === undefined ? "GET" : "POST",
    ) {
      for (let attempt = 0; ; attempt += 1) {
        const response = await fetch(`${stack.baseUrl}${path}`, {
          method,
          headers: {
            Cookie: [...this.cookies]
              .map(([key, value]) => `${key}=${value}`)
              .join("; "),
            ...(body === undefined
              ? {}
              : { Origin: stack.baseUrl, "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(15000),
        });
        for (const entry of response.headers.getSetCookie()) {
          const pair = entry.split(";")[0]!;
          const split = pair.indexOf("=");
          this.cookies.set(pair.slice(0, split), pair.slice(split + 1));
        }
        if (
          path.startsWith("/api/auth/") &&
          response.status === 429 &&
          attempt < 3
        ) {
          const seconds = Number(
            response.headers.get("retry-after") ??
              response.headers.get("x-retry-after"),
          );
          assert.ok(seconds > 0 && seconds <= 30);
          await response.text();
          await delay(seconds * 1000 + 100);
          continue;
        }
        return {
          response,
          body: (await response.json().catch(() => null)) as unknown,
        };
      }
    }
    headers() {
      return {
        Origin: stack.baseUrl,
        Cookie: [...this.cookies]
          .map(([key, value]) => `${key}=${value}`)
          .join("; "),
      };
    }
  }
  const owner = new Client();
  const viewer = new Client();
  try {
    await redis.connect();
    for (const [index, client] of [owner, viewer].entries())
      assert.equal(
        (
          await client.request("/api/auth/sign-up/email", {
            name: `Hardening ${index}`,
            email: emails[index],
            password,
          })
        ).response.status,
        200,
      );
    const project = createdProjectResponseSchema.parse(
      (await owner.request("/api/projects", { name: prefix })).body,
    ).project;
    projects.push(project.id);
    const item = itemResponseSchema.parse(
      (
        await owner.request(`/api/projects/${project.id}/items`, {
          type: "PAGE",
          title: "Hardening page",
        })
      ).body,
    ).item;
    const users = await database.user.findMany({
      where: { email: { in: emails } },
    });
    const ownerId = users.find((user) => user.email === emails[0])!.id;
    const viewerId = users.find((user) => user.email === emails[1])!.id;
    await database.projectMember.create({
      data: { projectId: project.id, userId: viewerId, role: "VIEWER" },
    });
    for (const policy of [
      "invite-create",
      "invite-join",
      "chat",
      "invite-preview",
    ]) {
      for (const id of [ownerId, viewerId])
        keys.add(`collab:limit:${policy}:user:${id}`);
      keys.add(`collab:limit:${policy}:project:${project.id}`);
    }
    const invitePath = `/api/projects/${project.id}/invites`;
    assert.equal(
      (await viewer.request(invitePath, { role: "EDITOR" })).response.status,
      403,
    );
    for (let index = 0; index < 10; index++)
      assert.equal(
        (await owner.request(invitePath, { role: "EDITOR" })).response.status,
        201,
      );
    const limited = await owner.request(invitePath, { role: "EDITOR" });
    assert.equal(limited.response.status, 429);
    assert.ok(Number(limited.response.headers.get("retry-after")) > 0);
    assert.match(
      limited.response.headers.get("x-request-id")!,
      /^[0-9a-f-]{36}$/,
    );
    assert.equal(
      await database.invite.count({ where: { projectId: project.id } }),
      10,
    );
    for (let index = 0; index < 10; index++)
      assert.equal(
        (await viewer.request(`/api/invites/${randomUUID()}/join`, {})).response
          .status,
        404,
      );
    assert.equal(
      (await viewer.request(`/api/invites/${randomUUID()}/join`, {})).response
        .status,
      429,
    );
    for (let index = 0; index < 60; index++)
      assert.equal(
        (await viewer.request(`/api/invites/${randomUUID()}`)).response.status,
        404,
      );
    assert.equal(
      (await viewer.request(`/api/invites/${randomUUID()}`)).response.status,
      429,
    );

    const token = realtimeTokenResponseSchema.parse(
      (await owner.request("/api/realtime-token", { projectId: project.id }))
        .body,
    );
    const socket = io(token.url, {
      auth: { token: token.token },
      transports: ["websocket"],
      reconnection: false,
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    await socket
      .timeout(5000)
      .emitWithAck("tree:subscribe", { projectId: project.id });
    const first = {
      projectId: project.id,
      clientMessageId: randomUUID(),
      body: "First limited chat",
    };
    async function send(input: unknown) {
      return chatSendAckSchema.parse(
        await socket.timeout(5000).emitWithAck("chat:send", input),
      );
    }
    assert.equal((await send(first)).ok, true);
    for (let index = 1; index < 30; index++)
      assert.equal(
        (
          await send({
            ...first,
            clientMessageId: randomUUID(),
            body: `Chat ${index}`,
          })
        ).ok,
        true,
      );
    const chatLimited = await send({ ...first, clientMessageId: randomUUID() });
    assert.equal(chatLimited.ok, false);
    if (!chatLimited.ok) {
      assert.equal(chatLimited.error.code, "RATE_LIMITED");
      assert.ok(chatLimited.retryAfter! > 0);
    }
    assert.equal((await send(first)).ok, true);
    assert.equal(
      await database.chatMessage.count({ where: { projectId: project.id } }),
      30,
    );
    console.log(
      "PASS invitation/chat quotas, retry metadata, current roles and idempotent chat retries",
    );

    const quotaProject = `${prefix}-quota`;
    keys.add(`collab:limit:chat:project:${quotaProject}`);
    for (let user = 0; user < 4; user++) {
      const id = `${prefix}-${user}`;
      keys.add(`collab:limit:chat:user:${id}`);
      for (let index = 0; index < 30; index++)
        await consumeRateLimit("chat", id, quotaProject);
    }
    const blockedUser = `${prefix}-blocked`;
    keys.add(`collab:limit:chat:user:${blockedUser}`);
    await assert.rejects(
      consumeRateLimit("chat", blockedUser, quotaProject),
      (error: unknown) =>
        error instanceof RateLimitError && error.code === "RATE_LIMITED",
    );
    assert.equal(
      await redis.get(`collab:limit:chat:user:${blockedUser}`),
      null,
    );
    const ttl = await redis.pTTL(`collab:limit:chat:project:${quotaProject}`);
    assert.ok(ttl > 0 && ttl <= 60000);
    const raceUser = `${prefix}-race`;
    keys.add(`collab:limit:chat:user:${raceUser}`);
    const attempts = await Promise.allSettled(
      Array.from({ length: 35 }, () => consumeRateLimit("chat", raceUser)),
    );
    assert.equal(
      attempts.filter((attempt) => attempt.status === "fulfilled").length,
      30,
    );
    for (const attempt of attempts)
      if (attempt.status === "rejected")
        assert.ok(
          attempt.reason instanceof RateLimitError &&
            attempt.reason.code === "RATE_LIMITED",
        );
    console.log(
      stack.fixture
        ? "PASS scoped quotas, expiry and concurrent limits (RESP fixture; Lua remains unverified locally)"
        : "PASS real Redis Lua: project quotas, expiry and concurrent limits are atomic",
    );

    const uploadUrl = `${stack.baseUrl}/api/projects/${project.id}/items/${item.id}/images`;
    async function upload(bytes: Uint8Array, mime: string, filename: string) {
      const form = new FormData();
      form.set(
        "file",
        new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }),
        filename,
      );
      return fetch(uploadUrl, {
        method: "POST",
        headers: owner.headers(),
        body: form,
      });
    }
    assert.equal(
      (
        await upload(
          new Uint8Array(8 * 1024 * 1024 + 1),
          "image/png",
          "large.png",
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await upload(
          new TextEncoder().encode("<svg onload='alert(1)'/>"),
          "image/svg+xml",
          "attack.svg",
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await upload(
          new TextEncoder().encode("<html>spoofed PNG</html>"),
          "image/png",
          "spoof.png",
        )
      ).status,
      400,
    );
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 65537));
        controller.close();
      },
    });
    const streamed = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        ...owner.headers(),
        "Content-Type": "multipart/form-data; boundary=phase8",
      },
      body: oversized,
      duplex: "half",
    } as RequestInit);
    assert.equal(streamed.status, 413);
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,attack",
      "//attacker.invalid",
      "java\nscript:alert(1)",
      "https://user:password@example.test/",
    ])
      assert.equal(safeLinkUrl(url), undefined);
    assert.equal(
      safeLinkUrl("https://example.test/safe"),
      "https://example.test/safe",
    );
    const html = await fetch(`${stack.baseUrl}/login`);
    const csp = html.headers.get("content-security-policy")!;
    assert.match(csp, /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    assert.match(csp, /object-src 'none'/);
    assert.ok(!csp.includes("unsafe-eval"));
    assert.equal(html.headers.get("x-content-type-options"), "nosniff");
    assert.equal(html.headers.get("x-frame-options"), "DENY");
    console.log(
      "PASS upload byte/type limits, unsafe link rejection and production security headers",
    );
    if (stack.fixture) {
      stack.fixture.setUnavailable(true);
      assert.equal(
        (await viewer.request(`/api/invites/${randomUUID()}`)).response.status,
        503,
      );
      const unavailable = await send({
        ...first,
        clientMessageId: randomUUID(),
      });
      assert.equal(unavailable.ok, false);
      if (!unavailable.ok)
        assert.equal(unavailable.error.code, "RATE_LIMIT_UNAVAILABLE");
      assert.equal(
        await database.chatMessage.count({ where: { projectId: project.id } }),
        30,
      );
      stack.fixture.setUnavailable(false);
      console.log(
        "PASS Redis outage fails closed without saving invitations or chat",
      );
    }
  } finally {
    stack.fixture?.setUnavailable(false);
    for (const socket of sockets) socket.disconnect();
    if (redis.isOpen) {
      await redis.del([...keys]).catch(() => undefined);
      redis.destroy();
    }
    if (previousRedis === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedis;
    await database.project.deleteMany({
      where: { id: { in: projects }, owner: { email: { in: emails } } },
    });
    await database.user.deleteMany({ where: { email: { in: emails } } });
    await database.$disconnect();
  }
}
