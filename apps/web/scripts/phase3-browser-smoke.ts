import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getDatabase } from "@collab/db";
import {
  authSignUpSchema,
  createProjectSchema,
  createdProjectResponseSchema,
  createInviteSchema,
  inviteResponseSchema,
  emptyInputSchema,
  joinInviteResponseSchema,
  createItemSchema,
  updateItemSchema,
  itemResponseSchema,
  deleteItemsResponseSchema,
  userColor,
} from "@collab/shared";

// Native Chrome DevTools Protocol: no browser automation dependency is needed.
// Protocol definitions: https://chromedevtools.github.io/devtools-protocol/
type JsonRecord = Record<string, unknown>;
type BrowserTab = { contextId: string; targetId: string; sessionId: string };
type PendingCommand = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};
type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Cookie = {
  name: string;
  value: string;
  url: string;
  httpOnly: boolean;
  sameSite: "Lax";
};

function record(value: unknown): JsonRecord {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    "Expected a protocol object",
  );
  return value as JsonRecord;
}
function string(value: unknown): string {
  assert.equal(typeof value, "string", "Expected a protocol string");
  return value as string;
}

class DevTools {
  private readonly pending = new Map<number, PendingCommand>();
  private nextId = 0;
  readonly exceptions: string[] = [];
  readonly consoleErrors: string[] = [];
  readonly consoleWarnings: string[] = [];
  readonly socket: WebSocket;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      const message = record(JSON.parse(string(event.data)) as unknown);
      if (typeof message.id === "number") {
        const command = this.pending.get(message.id);
        if (!command) return;
        this.pending.delete(message.id);
        clearTimeout(command.timeout);
        if (message.error)
          command.reject(
            new Error(
              `DevTools command failed: ${string(record(message.error).message)}`,
            ),
          );
        else command.resolve(message.result);
      } else if (message.method === "Runtime.exceptionThrown") {
        const details = record(record(message.params).exceptionDetails);
        this.exceptions.push(
          typeof details.text === "string"
            ? details.text
            : "Browser runtime exception",
        );
      } else if (message.method === "Runtime.consoleAPICalled") {
        const parameters = record(message.params);
        if (parameters.type !== "error" && parameters.type !== "warning")
          return;
        const args = Array.isArray(parameters.args) ? parameters.args : [];
        const text = args
          .map((arg: unknown) => {
            const argument = record(arg);
            return typeof argument.value === "string"
              ? argument.value
              : typeof argument.description === "string"
                ? argument.description
                : String(argument.value ?? argument.type ?? "");
          })
          .join(" ")
          .slice(0, 5000);
        if (parameters.type === "error") this.consoleErrors.push(text);
        else this.consoleWarnings.push(text);
      }
    });
    this.socket.addEventListener("close", () => {
      for (const command of this.pending.values()) {
        clearTimeout(command.timeout);
        command.reject(new Error("The isolated browser connection closed"));
      }
      this.pending.clear();
    });
  }
  async ready() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolveReady, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("DevTools connection timed out")),
        15_000,
      );
      this.socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolveReady();
        },
        { once: true },
      );
      this.socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("DevTools connection failed"));
        },
        { once: true },
      );
    });
  }
  send(
    method: string,
    params: JsonRecord = {},
    sessionId?: string,
  ): Promise<unknown> {
    if (this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(
        new Error("The isolated browser connection is closed"),
      );
    const id = ++this.nextId;
    return new Promise((resolveCommand, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30_000);
      this.pending.set(id, { resolve: resolveCommand, reject, timeout });
      this.socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }
  async evaluate(tab: BrowserTab, expression: string): Promise<unknown> {
    const response = record(
      await this.send(
        "Runtime.evaluate",
        {
          expression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        },
        tab.sessionId,
      ),
    );
    if (response.exceptionDetails) {
      const details = record(response.exceptionDetails);
      const exception = details.exception ? record(details.exception) : {};
      throw new Error(
        `Browser evaluation failed: ${String(exception.description ?? details.text)}`,
      );
    }
    return record(response.result).value;
  }
}

const baseUrl = new URL(process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000")
  .origin;
assert.ok(
  ["127.0.0.1", "localhost", "::1"].includes(new URL(baseUrl).hostname),
  "Run the browser smoke only against a local application",
);
const database = getDatabase();
const checkRuns = process.argv.includes("--phase6");
const checkChat = process.argv.includes("--phase7");
const checkCode = process.argv.includes("--phase5") || checkRuns || checkChat;
const checkPresence = process.argv.includes("--phase4") || checkCode;
const runId = randomUUID();
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const profileRoot = resolve(workspace, ".tools", "browser-smoke");
const artifactDirectory = resolve(profileRoot, runId);
assert.ok(
  artifactDirectory.startsWith(`${profileRoot}${sep}`),
  "The isolated browser profile must stay inside the workspace",
);
const profileDirectory = resolve(artifactDirectory, "profile");
const password = `Browser-smoke-${randomBytes(24).toString("hex")}`;
const names = ["owner", "editor-a", "editor-b", "viewer"] as const;
const emails = names.map(
  (name) => `phase3-browser-${runId}-${name}@example.test`,
);
const clients: HttpClient[] = [];
const tabs: BrowserTab[] = [];
const createdProjects: string[] = [];
let cleanupAllowed = false;
let browserProcess: ChildProcess | undefined;
let devtools: DevTools | undefined;
let browserFailure = "";

class HttpClient {
  readonly cookies = new Map<string, Cookie>();
  async request(path: string, method: Method = "GET", body?: unknown) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(new URL(path, baseUrl), {
        method,
        headers: {
          Cookie: [...this.cookies.values()]
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join("; "),
          ...(method === "GET"
            ? {}
            : { Origin: baseUrl, "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429 && attempt < 3) {
        const retryAfter = Number(
          response.headers.get("retry-after") ??
            response.headers.get("x-retry-after"),
        );
        assert.ok(
          Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter <= 45,
          "Auth retry delay must be bounded",
        );
        await response.body?.cancel();
        console.log(`WAIT auth rate limit ${Math.ceil(retryAfter)} seconds`);
        await delay(Math.ceil(retryAfter * 1000) + 100);
        continue;
      }
      for (const serialized of response.headers.getSetCookie()) {
        const first = serialized.split(";")[0];
        if (!first) continue;
        const separator = first.indexOf("=");
        if (separator < 1) continue;
        const name = first.slice(0, separator);
        this.cookies.set(name, {
          name,
          value: first.slice(separator + 1),
          url: baseUrl,
          httpOnly: /;\s*httponly/i.test(serialized),
          sameSite: "Lax",
        });
      }
      const result: unknown = await response.json();
      assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`);
      return result;
    }
    throw new Error("Authentication retry bound exceeded");
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 45_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`${label} timed out after ${timeoutMs} ms`);
}
function pass(message: string) {
  console.log(`PASS ${message}`);
}
function browser(): DevTools {
  assert.ok(devtools);
  return devtools;
}
function firstClient(): HttpClient {
  const client = clients[0];
  assert.ok(client);
  return client;
}
function firstTab(): BrowserTab {
  const tab = tabs[0];
  assert.ok(tab);
  return tab;
}

async function startBrowser() {
  const executable = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].find((path) => path && existsSync(path));
  assert.ok(
    executable,
    "Install Chrome or Edge, or set CHROME_PATH, before running this test",
  );
  await mkdir(profileDirectory, { recursive: true });
  browserProcess = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--window-size=1440,1000",
      "about:blank",
    ],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  browserProcess.stderr?.on("data", (data: Buffer) => {
    browserFailure = (browserFailure + data.toString("utf8")).slice(-4000);
  });
  browserProcess.on("error", (error: Error) => {
    browserFailure = error.message;
  });
  const portFile = resolve(profileDirectory, "DevToolsActivePort");
  let endpoint: { port: number; path: string } | undefined;
  await waitUntil(
    async () => {
      assert.ok(
        browserProcess?.exitCode === null,
        `Isolated Chrome failed to start: ${browserFailure}`,
      );
      try {
        const [portText, path] = (await readFile(portFile, "utf8"))
          .trim()
          .split(/\r?\n/);
        const port = Number(portText);
        if (
          Number.isInteger(port) &&
          port > 0 &&
          port <= 65535 &&
          path?.startsWith("/devtools/browser/")
        ) {
          endpoint = { port, path };
          return true;
        }
        return false;
      } catch (error) {
        // Chrome creates this file before finishing its write on Windows.
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "EBUSY")
        )
          return false;
        throw error;
      }
    },
    "Isolated Chrome startup",
    20_000,
  );
  assert.ok(endpoint, "Expected a local browser debugging endpoint");
  devtools = new DevTools(`ws://127.0.0.1:${endpoint.port}${endpoint.path}`);
  await devtools.ready();
}

async function openTab(client: HttpClient, url: string) {
  const cdp = browser();
  const contextId = string(
    record(
      await cdp.send("Target.createBrowserContext", { disposeOnDetach: true }),
    ).browserContextId,
  );
  const targetId = string(
    record(
      await cdp.send("Target.createTarget", {
        url: "about:blank",
        browserContextId: contextId,
      }),
    ).targetId,
  );
  const sessionId = string(
    record(await cdp.send("Target.attachToTarget", { targetId, flatten: true }))
      .sessionId,
  );
  const tab: BrowserTab = { contextId, targetId, sessionId };
  tabs.push(tab);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);
  await cdp.send(
    "Network.setCookies",
    { cookies: [...client.cookies.values()] },
    sessionId,
  );
  await cdp.send("Page.navigate", { url }, sessionId);
  await waitUntil(
    async () =>
      (await cdp.evaluate(
        tab,
        "Boolean(document.querySelector('.bn-editor'))",
      )) === true,
    "BlockNote mount",
    60_000,
  );
  return tab;
}

async function visibleText(tab: BrowserTab) {
  return string(
    await browser().evaluate(
      tab,
      "(() => { const editor = document.querySelector('.bn-editor'); if (!editor) return ''; const copy = editor.cloneNode(true); copy.querySelectorAll('.bn-collaboration-cursor__base, .ProseMirror-yjs-cursor').forEach(cursor => cursor.remove()); return copy.textContent.replace(/\\u2060/g, '').trim(); })()",
    ),
  );
}
async function focusParagraph(tab: BrowserTab, atEnd = false) {
  assert.equal(
    await browser().evaluate(
      tab,
      `(() => {
    const editor = document.querySelector('.bn-editor');
    const paragraph = editor?.querySelector('[data-content-type="paragraph"] p') ?? editor?.querySelector('p');
    if (!editor || !paragraph) return false;
    editor.focus();
    const range = document.createRange(); range.selectNodeContents(paragraph); range.collapse(${!atEnd});
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); return true;
  })()`,
    ),
    true,
    "An editable paragraph must exist",
  );
}
async function key(
  tab: BrowserTab,
  name: string,
  code: string,
  keyCode: number,
  modifiers = 0,
) {
  await browser().send(
    "Input.dispatchKeyEvent",
    {
      type: "keyDown",
      key: name,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    },
    tab.sessionId,
  );
  await browser().send(
    "Input.dispatchKeyEvent",
    {
      type: "keyUp",
      key: name,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    },
    tab.sessionId,
  );
}
async function chooseSlash(tab: BrowserTab, label: string) {
  await browser().send("Input.insertText", { text: "/" }, tab.sessionId);
  await waitUntil(
    async () =>
      (await browser().evaluate(
        tab,
        "Boolean(document.querySelector('.bn-suggestion-menu [role=option]'))",
      )) === true,
    "Slash menu",
  );
  assert.equal(
    await browser().evaluate(
      tab,
      `(() => { const option = [...document.querySelectorAll('.bn-suggestion-menu [role=option]')].find(element => element.textContent?.trim().startsWith(${JSON.stringify(label)})); if (!option) return false; option.click(); return true; })()`,
    ),
    true,
    `${label} slash command must exist`,
  );
}
async function allTabs(predicate: string, label: string) {
  await waitUntil(
    async () =>
      (
        await Promise.all(tabs.map((tab) => browser().evaluate(tab, predicate)))
      ).every((value) => value === true),
    label,
  );
}

async function setOffline(tab: BrowserTab, offline: boolean) {
  const conditions = {
    offline,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  };
  await browser().send(
    "Network.emulateNetworkConditionsByRule",
    {
      matchedNetworkConditions: offline
        ? [{ ...conditions, urlPattern: "" }]
        : [],
    },
    tab.sessionId,
  );
  await browser().send(
    "Network.overrideNetworkState",
    conditions,
    tab.sessionId,
  );
}

async function verifyOfflineMerge() {
  const disconnected = tabs[2];
  assert.ok(disconnected);
  const onlinePeers = tabs.filter((tab) => tab !== disconnected);
  await setOffline(disconnected, true);
  try {
    await waitUntil(
      async () =>
        (await browser().evaluate(
          disconnected,
          "navigator.onLine === false && document.querySelector('[aria-label=\"Collaborative page\"]')?.textContent.includes('Offline.')",
        )) === true,
      "Visible offline page state",
    );
    await focusParagraph(disconnected);
    await browser().send(
      "Input.insertText",
      { text: "OfflineBrowserEdit " },
      disconnected.sessionId,
    );
    await waitUntil(
      async () =>
        (await visibleText(disconnected)).includes("OfflineBrowserEdit"),
      "Local offline edit",
    );
    await focusParagraph(firstTab());
    await browser().send(
      "Input.insertText",
      { text: "OnlineBrowserEdit " },
      firstTab().sessionId,
    );
    await waitUntil(
      async () =>
        (await Promise.all(onlinePeers.map(visibleText))).every((text) =>
          text.includes("OnlineBrowserEdit"),
        ),
      "Connected editors continue syncing",
    );
    await delay(500);
    assert.ok(
      (await Promise.all(onlinePeers.map(visibleText))).every(
        (text) => !text.includes("OfflineBrowserEdit"),
      ),
      "Offline transport must hold local edits away from connected peers",
    );
    assert.ok(
      !(await visibleText(disconnected)).includes("OnlineBrowserEdit"),
      "Offline editor must not receive connected peers' changes before reconnecting",
    );
  } finally {
    await setOffline(disconnected, false);
  }
  await waitUntil(
    async () => {
      const values = await Promise.all(tabs.map(visibleText));
      return (
        values.every(
          (text) =>
            text.includes("OfflineBrowserEdit") &&
            text.includes("OnlineBrowserEdit"),
        ) && new Set(values).size === 1
      );
    },
    "Offline and online edits merge after reconnect",
    60_000,
  );
  await allTabs(
    "document.querySelector('[aria-label=\"Collaborative page\"]')?.textContent.includes('All changes synced') === true",
    "Reconnected page edits acknowledged",
  );
  pass(
    "one browser keeps offline edits local, merges simultaneous online changes after reconnect, and recovers the synced status",
  );
}

async function verifyProjectPresence(projectId: string, pageId: string) {
  const list =
    "document.querySelector('[aria-label=\"Online project members\"]')";
  await allTabs(
    `${list}?.children.length === 4`,
    "Four project-wide online members",
  );
  await allTabs(
    `${list}?.textContent.includes('Browser document') === true`,
    "Online members show their viewed page",
  );
  const observer = tabs[3];
  const movingEditor = tabs[1];
  assert.ok(observer && movingEditor);
  await focusParagraph(firstTab());
  const cursor =
    "[...document.querySelectorAll('.bn-collaboration-cursor__base')].find(element => element.querySelector('.bn-collaboration-cursor__label')?.textContent === 'Browser owner')";
  await waitUntil(
    async () =>
      (await browser().evaluate(observer, `Boolean(${cursor})`)) === true,
    "Named remote cursor appears",
    5000,
  );
  const before = Number(
    await browser().evaluate(observer, `(${cursor}).getBoundingClientRect().x`),
  );
  for (let index = 0; index < 6; index += 1)
    await key(firstTab(), "ArrowRight", "ArrowRight", 39);
  await waitUntil(
    async () =>
      Math.abs(
        Number(
          await browser().evaluate(
            observer,
            `(${cursor})?.getBoundingClientRect().x`,
          ),
        ) - before,
      ) > 2,
    "Remote cursor movement",
    5000,
  );
  const storedOwner = await database.user.findUniqueOrThrow({
    where: { email: emails[0]! },
  });
  const color = userColor(storedOwner.id);
  const rgb = `rgb(${parseInt(color.slice(1, 3), 16)}, ${parseInt(color.slice(3, 5), 16)}, ${parseInt(color.slice(5, 7), 16)})`;
  assert.equal(
    await browser().evaluate(
      observer,
      `getComputedStyle((${cursor}).querySelector('.bn-collaboration-cursor__caret')).backgroundColor`,
    ),
    rgb,
  );
  pass(
    "Remote cursor has a visible name and verified user color, and moves within five seconds of real keyboard navigation",
  );

  const { item: destination } = itemResponseSchema.parse(
    await firstClient().request(
      `/api/projects/${projectId}/items`,
      "POST",
      createItemSchema.parse({
        title: "Presence destination",
        type: "PAGE",
        parentId: null,
      }),
    ),
  );
  const destinationPath = `/projects/${projectId}/${destination.id}`;
  await allTabs(
    `Boolean(document.querySelector('a[href="${destinationPath}"]'))`,
    "Presence destination appears in sidebars",
  );
  await browser().evaluate(
    movingEditor,
    `document.querySelector('a[href="${destinationPath}"]').click()`,
  );
  await waitUntil(
    async () =>
      (await browser().evaluate(
        movingEditor,
        `location.pathname === '${destinationPath}' && Boolean(document.querySelector('.bn-editor'))`,
      )) === true,
    "Editor navigates to another page",
  );
  await allTabs(
    `${list}?.textContent.includes('Presence destination') === true && ${list}?.children.length === 4`,
    "Project presence follows page navigation",
  );
  await waitUntil(
    async () =>
      (await browser().evaluate(
        firstTab(),
        "Boolean(document.querySelector('[aria-label=\"3 people on this page\"]'))",
      )) === true,
    "Page avatars remove departed editor",
    5000,
  );
  itemResponseSchema.parse(
    await firstClient().request(
      `/api/projects/${projectId}/items/${destination.id}`,
      "PATCH",
      updateItemSchema.parse({
        action: "rename",
        title: "Renamed presence page",
      }),
    ),
  );
  await allTabs(
    `${list}?.textContent.includes('Renamed presence page') === true`,
    "Presence location title follows tree rename",
  );
  pass(
    "Online members remain visible across pages; their clickable locations follow page navigation and live renames",
  );

  const extra = await openTab(firstClient(), `${baseUrl}${destinationPath}`);
  await allTabs(
    `${list}?.children.length === 4`,
    "Extra owner tab does not duplicate a member",
  );
  await waitUntil(
    async () =>
      (await browser().evaluate(
        firstTab(),
        `${list}?.firstElementChild?.textContent.includes('Browser') === true && [...${list}.children].some(member => member.textContent.includes('Browser owner') && member.querySelectorAll('a').length === 2)`,
      )) === true,
    "Both owner tab locations shown",
  );
  await browser().send("Target.closeTarget", { targetId: extra.targetId });
  tabs.splice(tabs.indexOf(extra), 1);
  await browser().send("Target.disposeBrowserContext", {
    browserContextId: extra.contextId,
  });
  await waitUntil(
    async () =>
      (await browser().evaluate(
        firstTab(),
        `[...${list}.children].some(member => member.textContent.includes('Browser owner') && member.querySelectorAll('a').length === 1) && ${list}.children.length === 4`,
      )) === true,
    "Extra tab location disappears",
    5000,
  );
  pass(
    "Multiple tabs produce one online member with both locations; closing one tab removes only that location within five seconds",
  );

  await browser().evaluate(
    observer,
    `document.querySelector('[aria-label="Project sidebar"] > a').click()`,
  );
  await waitUntil(
    async () =>
      (await browser().evaluate(
        firstTab(),
        `[...${list}?.children ?? []].some(member => member.textContent.includes('Browser viewer') && member.textContent.includes('Project overview'))`,
      )) === true,
    "Viewer overview location broadcast",
  );
  await browser().evaluate(
    observer,
    `document.querySelector('a[href="/projects/${projectId}/${pageId}"]').click()`,
  );
  await waitUntil(
    async () =>
      (await browser().evaluate(
        observer,
        "Boolean(document.querySelector('.bn-editor'))",
      )) === true,
    "Viewer returns to page",
  );
  await focusParagraph(movingEditor);
  await browser().evaluate(
    movingEditor,
    `document.querySelector('a[href="/projects/${projectId}/${pageId}"]').click()`,
  );
  await waitUntil(
    async () =>
      (await browser().evaluate(
        movingEditor,
        `location.pathname === '/projects/${projectId}/${pageId}' && Boolean(document.querySelector('.bn-editor'))`,
      )) === true,
    "Editor returns to shared page",
  );
  await focusParagraph(movingEditor);
  const closedCursor =
    "[...document.querySelectorAll('.bn-collaboration-cursor__label')].some(label => label.textContent === 'Browser editor-a')";
  await waitUntil(
    async () => (await browser().evaluate(observer, closedCursor)) === true,
    "Cursor before tab closure",
    5000,
  );
  await browser().send("Target.closeTarget", {
    targetId: movingEditor.targetId,
  });
  tabs.splice(tabs.indexOf(movingEditor), 1);
  await browser().send("Target.disposeBrowserContext", {
    browserContextId: movingEditor.contextId,
  });
  await waitUntil(
    async () =>
      (await browser().evaluate(
        observer,
        `!(${closedCursor}) && ${list}?.children.length === 3 && !${list}.textContent.includes('Browser editor-a') && Boolean(document.querySelector('[aria-label="3 people on this page"]'))`,
      )) === true,
    "Closed tab removes cursor, avatars and online member",
    5000,
  );
  pass(
    "Closing the last tab removes the remote cursor, page avatar and project online entry within five seconds",
  );
}

async function codeText(tab: BrowserTab) {
  return string(
    await browser().evaluate(
      tab,
      "document.querySelector('.monaco-editor .view-lines')?.textContent.replace(/\\u00a0/g, ' ') ?? ''",
    ),
  );
}
async function focusCode(tab: BrowserTab) {
  assert.equal(
    await browser().evaluate(
      tab,
      "(() => { const input = document.querySelector('.monaco-editor textarea'); if (!input) return false; input.focus(); return true; })()",
    ),
    true,
  );
}
async function verifyChat(projectId: string) {
  const owner = firstTab();
  const editor = tabs[1]!;
  const viewer = tabs[3]!;
  const composer = "document.querySelector('#chat-message')";
  const chat = "document.querySelector('[aria-label=\"Chat messages\"]')";
  await waitUntil(
    async () =>
      (await browser().evaluate(
        owner,
        `${composer} !== null && !document.body.textContent.includes('Chat is reconnecting')`,
      )) === true,
    "chat socket ready",
  );
  assert.equal(
    await browser().evaluate(
      viewer,
      `${composer} === null && document.body.textContent.includes('read-only chat access')`,
    ),
    true,
  );
  async function fill(tab: BrowserTab, text: string) {
    await browser().evaluate(tab, `${composer}.focus()`);
    await key(tab, "a", "KeyA", 65, 2);
    if (text) await browser().send("Input.insertText", { text }, tab.sessionId);
    else await key(tab, "Backspace", "Backspace", 8);
  }
  await fill(editor, "Typing draft");
  await waitUntil(
    async () =>
      (await browser().evaluate(
        viewer,
        "document.querySelector('[aria-label=\"Chat typing status\"]')?.textContent.includes('Browser editor-a is typing')",
      )) === true,
    "chat typing indicator",
  );
  await browser().evaluate(editor, `${composer}.blur()`);
  await waitUntil(
    async () =>
      (await browser().evaluate(
        viewer,
        "document.querySelector('[aria-label=\"Chat typing status\"]')?.textContent === ''",
      )) === true,
    "typing stops on blur",
  );
  await fill(editor, "");
  await browser().evaluate(
    viewer,
    "document.querySelector('[aria-label=\"Collapse chat\"]').click()",
  );
  const htmlText = "Browser chat <script>window.chatInjected=true</script>";
  await fill(owner, htmlText);
  await key(owner, "Enter", "Enter", 13);
  await waitUntil(
    async () =>
      (await browser().evaluate(
        owner,
        `${chat}?.textContent.includes(${JSON.stringify(htmlText)}) && ${composer}.value === ''`,
      )) === true,
    "chat send confirmed",
  );
  await waitUntil(
    async () =>
      (await browser().evaluate(
        viewer,
        "document.querySelector('[aria-label=\"1 unread messages\"]') !== null",
      )) === true,
    "collapsed viewer unread badge",
  );
  await browser().send("Page.bringToFront", {}, viewer.sessionId);
  await browser().evaluate(
    viewer,
    "document.querySelector('[aria-label=\"Expand chat\"]').click()",
  );
  await allTabs(
    `${chat}?.textContent.includes(${JSON.stringify(htmlText)}) === true`,
    "chat reaches all browsers",
  );
  await waitUntil(
    async () =>
      (await browser().evaluate(
        viewer,
        "document.querySelector('[aria-label=\"1 unread messages\"]') === null",
      )) === true,
    "reading chat clears unread badge",
  );
  for (const tab of tabs)
    assert.equal(
      await browser().evaluate(tab, "typeof window.chatInjected"),
      "undefined",
    );
  await fill(owner, "Second grouped message");
  await key(owner, "Enter", "Enter", 13);
  await allTabs(
    `${chat}?.textContent.includes('Second grouped message') === true`,
    "second grouped message",
  );
  assert.equal(
    await browser().evaluate(owner, `${chat}.querySelectorAll('time').length`),
    1,
  );
  await browser().send("Page.reload", { ignoreCache: true }, viewer.sessionId);
  await waitUntil(
    async () =>
      (await browser().evaluate(
        viewer,
        `${chat}?.textContent.includes('Second grouped message') === true`,
      )) === true,
    "late viewer restores saved chat",
    60000,
  );
  const ownerAccount = await database.user.findUniqueOrThrow({
    where: { email: emails[0]! },
  });
  await database.chatMessage.createMany({
    data: Array.from({ length: 55 }, (_, index) => ({
      projectId,
      userId: ownerAccount.id,
      body: `Browser older ${index}`,
      createdAt: new Date(Date.now() - 600000),
    })),
  });
  await browser().send("Page.reload", { ignoreCache: true }, owner.sessionId);
  await waitUntil(
    async () =>
      (await browser().evaluate(
        owner,
        "(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Load older messages'); if (!button || button.disabled) return false; button.click(); return true; })()",
      )) === true,
    "older chat ready to load",
    60000,
  );
  await waitUntil(
    async () =>
      (await browser().evaluate(
        owner,
        `${chat}?.querySelectorAll('li').length === 57`,
      )) === true,
    "older cursor page loads without duplicate messages",
  );
  await fill(owner, "Offline chat draft");
  await setOffline(owner, true);
  await waitUntil(
    async () =>
      (await browser().evaluate(
        owner,
        "[...document.querySelectorAll('button')].some(button => button.textContent === 'Send' && button.disabled)",
      )) === true,
    "offline chat send disabled",
  );
  await fill(editor, "Sent while owner offline");
  await key(editor, "Enter", "Enter", 13);
  await waitUntil(
    async () =>
      (await browser().evaluate(
        editor,
        `${chat}?.textContent.includes('Sent while owner offline') === true`,
      )) === true,
    "online collaborator sends while peer offline",
  );
  await setOffline(owner, false);
  await waitUntil(
    async () =>
      (await browser().evaluate(
        owner,
        `${chat}?.textContent.includes('Sent while owner offline') === true && ${composer}?.value === 'Offline chat draft' && [...document.querySelectorAll('button')].some(button => button.textContent === 'Send' && !button.disabled)`,
      )) === true,
    "chat reconnect restores missed message and retains draft",
    60000,
  );
  await key(owner, "Enter", "Enter", 13);
  await allTabs(
    `${chat}?.textContent.includes('Offline chat draft') === true`,
    "retained draft sends after reconnect",
  );
  pass(
    "Chat sends to all roles, viewers read only, typing clears, unread badges clear on reading, messages group, late joins/load-older/reconnect restore history, offline drafts survive and HTML renders as text",
  );
}

async function verifyCodeEditor(projectId: string) {
  await browser().evaluate(
    firstTab(),
    "document.querySelector('[aria-label=\"Add page, code file or folder\"]').click()",
  );
  await waitUntil(
    async () =>
      (await browser().evaluate(
        firstTab(),
        "Boolean(document.querySelector('dialog[open] select[name=type]'))",
      )) === true,
    "Add dialog opens",
  );
  await browser().evaluate(
    firstTab(),
    "(() => { const type = document.querySelector('dialog[open] select[name=type]'); type.value = 'CODE'; type.dispatchEvent(new Event('change', { bubbles: true })); })()",
  );
  await waitUntil(
    async () =>
      (await browser().evaluate(
        firstTab(),
        "document.querySelector('dialog[open] select[name=language]')?.value === 'javascript'",
      )) === true,
    "Code language appears in the Add dialog",
  );
  await browser().evaluate(
    firstTab(),
    "(() => { const form = document.querySelector('dialog[open] form'); const title = form.querySelector('input[name=title]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(title, 'main.js'); title.dispatchEvent(new Event('input', { bubbles: true })); form.requestSubmit(); })()",
  );
  await waitUntil(
    async () =>
      (await browser().evaluate(
        firstTab(),
        "Boolean(document.querySelector('.monaco-editor textarea'))",
      )) === true,
    "Creating a code file opens Monaco",
    60000,
  );
  const item = await database.item.findFirstOrThrow({
    where: { projectId, title: "main.js", type: "CODE" },
  });
  assert.equal(item.language, "javascript");
  pass(
    "The Add dialog creates a code file with its chosen language and opens Monaco",
  );
  const path = `/projects/${projectId}/${item.id}`;
  await allTabs(
    `Boolean(document.querySelector('a[href="${path}"]'))`,
    "Code file appears in every sidebar",
  );
  for (const tab of tabs)
    await browser().evaluate(
      tab,
      `document.querySelector('a[href="${path}"]').click()`,
    );
  await allTabs(
    "Boolean(document.querySelector('.monaco-editor textarea'))",
    "Real Monaco editors mount lazily",
  );
  const owner = firstTab();
  const editor = tabs[1];
  const viewer = tabs[2];
  assert.ok(editor && viewer);
  await focusCode(owner);
  await browser().send(
    "Input.insertText",
    { text: "// SharedCodeSeed\n" },
    owner.sessionId,
  );
  await waitUntil(
    async () =>
      (await Promise.all(tabs.map(codeText))).every((value) =>
        value.includes("SharedCodeSeed"),
      ),
    "Code seed reaches every editor",
  );
  await Promise.all([owner, editor].map(focusCode));
  await Promise.all(
    [owner, editor].map((tab, index) =>
      browser().send(
        "Input.insertText",
        { text: index === 0 ? "// AlphaCode\n" : "// BravoCode\n" },
        tab.sessionId,
      ),
    ),
  );
  await waitUntil(async () => {
    const values = await Promise.all(tabs.map(codeText));
    return (
      new Set(values).size === 1 &&
      values.every(
        (value) => value.includes("AlphaCode") && value.includes("BravoCode"),
      )
    );
  }, "Two real Monaco editors converge");
  pass(
    "Two Monaco browsers type concurrently with no lost text; the viewer receives matching code",
  );
  assert.equal(
    await browser().evaluate(
      viewer,
      "document.querySelector('.monaco-editor textarea').readOnly",
    ),
    true,
  );
  assert.equal(
    await browser().evaluate(
      viewer,
      "document.querySelector('[aria-label=\"Code language\"]').disabled",
    ),
    true,
  );
  await focusCode(viewer);
  await browser().send(
    "Input.insertText",
    { text: "FORBIDDEN_VIEWER_CODE" },
    viewer.sessionId,
  );
  await delay(300);
  assert.ok(!(await codeText(owner)).includes("FORBIDDEN_VIEWER_CODE"));
  assert.ok(!(await codeText(viewer)).includes("FORBIDDEN_VIEWER_CODE"));
  await browser().evaluate(
    owner,
    "(() => { const picker = document.querySelector('[aria-label=\"Code language\"]'); picker.value = 'python'; picker.dispatchEvent(new Event('change', { bubbles: true })); })()",
  );
  await allTabs(
    "document.querySelector('[aria-label=\"Code language\"]')?.value === 'python'",
    "Language picker syncs to editors and viewer",
  );
  assert.equal(
    (await database.item.findUniqueOrThrow({ where: { id: item.id } }))
      .language,
    "python",
  );
  pass(
    "Language changes from the UI reach all collaborators and persist on the Item; viewers cannot type or change language",
  );

  await focusCode(owner);
  await key(owner, "Home", "Home", 36, 2);
  await key(owner, "ArrowRight", "ArrowRight", 39);
  const cursor = "document.querySelector('.yRemoteSelectionHead')";
  await waitUntil(
    async () =>
      (await browser().evaluate(viewer, `Boolean(${cursor})`)) === true,
    "Monaco remote cursor appears",
    5000,
  );
  const ownerCursor =
    "[...document.querySelectorAll('.yRemoteSelectionHead')].find(element => getComputedStyle(element, '::after').content.includes('Browser owner'))";
  await waitUntil(
    async () =>
      (await browser().evaluate(viewer, `Boolean(${ownerCursor})`)) === true,
    "Monaco cursor name label",
    5000,
  );
  const cursorX = Number(
    await browser().evaluate(
      viewer,
      `(${ownerCursor}).getBoundingClientRect().x`,
    ),
  );
  for (let index = 0; index < 5; index += 1)
    await key(owner, "ArrowRight", "ArrowRight", 39);
  await waitUntil(
    async () =>
      Math.abs(
        Number(
          await browser().evaluate(
            viewer,
            `(${ownerCursor})?.getBoundingClientRect().x`,
          ),
        ) - cursorX,
      ) > 2,
    "Monaco remote cursor moves",
    5000,
  );
  const user = await database.user.findUniqueOrThrow({
    where: { email: emails[0]! },
  });
  const color = userColor(user.id);
  const rgb = `rgb(${parseInt(color.slice(1, 3), 16)}, ${parseInt(color.slice(3, 5), 16)}, ${parseInt(color.slice(5, 7), 16)})`;
  assert.equal(
    await browser().evaluate(
      viewer,
      `getComputedStyle((${ownerCursor})).borderLeftColor`,
    ),
    rgb,
  );
  pass(
    "Monaco remote cursors display verified names and colors and move with real keyboard input",
  );

  await browser().evaluate(
    owner,
    "(() => { const select = document.querySelector('[aria-label=\"Code editor appearance\"]'); select.value = 'vs-dark'; select.dispatchEvent(new Event('change', { bubbles: true })); })()",
  );
  await waitUntil(
    async () =>
      (await browser().evaluate(
        owner,
        "Boolean(document.querySelector('.monaco-editor.vs-dark'))",
      )) === true,
    "Dark code theme",
  );
  assert.equal(
    await browser().evaluate(
      viewer,
      "Boolean(document.querySelector('.monaco-editor.vs-dark'))",
    ),
    false,
  );
  await browser().evaluate(
    owner,
    "(() => { const input = document.querySelector('[aria-label=\"Code font size\"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '18'); input.dispatchEvent(new Event('input', { bubbles: true })); })()",
  );
  await waitUntil(
    async () =>
      (await browser().evaluate(
        owner,
        "document.querySelector('.monaco-editor .view-lines').style.fontSize === '18px'",
      )) === true,
    "Code font size updates",
  );
  await browser().evaluate(
    owner,
    "(() => { const input = document.querySelector('[aria-label=\"Standard input\"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'hello stdin'); input.dispatchEvent(new Event('input', { bubbles: true })); })()",
  );
  assert.equal(
    await browser().evaluate(
      owner,
      "document.querySelector('[aria-label=\"Standard input\"]').value",
    ),
    "hello stdin",
  );
  assert.equal(
    await browser().evaluate(
      editor,
      "document.querySelector('[aria-label=\"Standard input\"]').value",
    ),
    "",
  );
  pass(
    "Theme and font size update the real editor locally; stdin remains a private tab draft",
  );

  await setOffline(editor, true);
  try {
    await focusCode(editor);
    await browser().send(
      "Input.insertText",
      { text: "# OfflineCode " },
      editor.sessionId,
    );
    await waitUntil(
      async () => (await codeText(editor)).includes("OfflineCode"),
      "Local offline code edit",
    );
    await focusCode(owner);
    await browser().send(
      "Input.insertText",
      { text: "# OnlineCode " },
      owner.sessionId,
    );
    await waitUntil(
      async () => (await codeText(viewer)).includes("OnlineCode"),
      "Peers keep editing code online",
    );
    assert.ok(!(await codeText(owner)).includes("OfflineCode"));
  } finally {
    await setOffline(editor, false);
  }
  await waitUntil(
    async () => {
      const values = await Promise.all(tabs.map(codeText));
      return (
        new Set(values).size === 1 &&
        values.every(
          (value) =>
            value.includes("OnlineCode") && value.includes("OfflineCode"),
        )
      );
    },
    "Offline code edits merge after reconnect",
    60000,
  );
  const expected = await codeText(owner);
  await allTabs(
    "document.querySelector('[aria-label=\"Collaborative code file\"]')?.textContent.includes('All changes synced') === true",
    "Code changes acknowledged",
  );
  await browser().send("Page.reload", { ignoreCache: true }, owner.sessionId);
  await waitUntil(
    async () => (await codeText(owner)) === expected,
    "Code reload restores text",
    60000,
  );
  assert.equal(
    await browser().evaluate(
      owner,
      "document.querySelector('[aria-label=\"Code language\"]').value",
    ),
    "python",
  );
  assert.equal(
    await browser().evaluate(
      owner,
      "Boolean(document.querySelector('.monaco-editor.vs-dark'))",
    ),
    true,
  );
  assert.equal(
    await browser().evaluate(
      owner,
      "document.querySelector('[aria-label=\"Code font size\"]').value",
    ),
    "18",
  );
  pass(
    "Offline code merges after reconnect; reload restores code, shared language and local editor preferences",
  );
  await focusCode(editor);
  await key(editor, "ArrowRight", "ArrowRight", 39);
  const closingCursor =
    "[...document.querySelectorAll('.yRemoteSelectionHead')].some(element => getComputedStyle(element, '::after').content.includes('Browser editor-b'))";
  await waitUntil(
    async () => (await browser().evaluate(viewer, closingCursor)) === true,
    "Code cursor before tab close",
  );
  await browser().send("Target.closeTarget", { targetId: editor.targetId });
  tabs.splice(tabs.indexOf(editor), 1);
  await browser().send("Target.disposeBrowserContext", {
    browserContextId: editor.contextId,
  });
  await waitUntil(
    async () =>
      (await browser().evaluate(
        viewer,
        `!(${closingCursor}) && document.querySelector('[aria-label="Online project members"]')?.children.length === 2`,
      )) === true,
    "Code tab cleanup",
    5000,
  );
  pass(
    "Closing a code tab removes its remote cursor and online presence within five seconds",
  );
  if (checkRuns) {
    await focusCode(owner);
    await key(owner, "a", "KeyA", 65, 2);
    await browser().send(
      "Input.insertText",
      { text: "print(input())\n" },
      owner.sessionId,
    );
    await allTabs(
      "document.querySelector('[aria-label=\"Collaborative code file\"]')?.textContent.includes('All changes synced') === true",
      "Code snapshot is synced before running",
    );
    await browser().evaluate(
      owner,
      "(() => { const input = document.querySelector('[aria-label=\"Standard input\"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'browser-shared <script>window.collabRunOutputExecuted=true</script>'); input.dispatchEvent(new Event('input', { bubbles: true })); })()",
    );
    await waitUntil(
      async () =>
        (await browser().evaluate(
          owner,
          "[...document.querySelectorAll('button')].some(button => button.textContent === 'Run' && !button.disabled)",
        )) === true,
      "Run button ready",
    );
    assert.equal(
      await browser().evaluate(
        viewer,
        "[...document.querySelectorAll('button')].some(button => button.textContent === 'Run')",
      ),
      false,
    );
    await browser().evaluate(
      owner,
      "[...document.querySelectorAll('button')].find(button => button.textContent === 'Run').click()",
    );
    await allTabs(
      "document.querySelector('[aria-label=\"Run output\"]')?.textContent.includes('browser-shared <script>window.collabRunOutputExecuted=true</script>') === true && document.querySelector('[aria-label=\"Run output\"]')?.textContent.includes('Exit code: 0') === true",
      "Shared stdout and exit code reach every real browser",
    );
    for (const tab of tabs) {
      assert.equal(
        await browser().evaluate(tab, "typeof window.collabRunOutputExecuted"),
        "undefined",
      );
      await browser().evaluate(
        tab,
        "document.querySelector('[aria-label=\"Code execution\"] summary').click()",
      );
      assert.equal(
        await browser().evaluate(
          tab,
          "document.querySelector('[aria-label=\"Run history\"]')?.textContent.includes('Accepted')",
        ),
        true,
      );
    }
    await browser().send(
      "Page.reload",
      { ignoreCache: true },
      viewer.sessionId,
    );
    await waitUntil(
      async () =>
        (await browser().evaluate(
          viewer,
          "document.querySelector('[aria-label=\"Standard output\"]')?.textContent.includes('browser-shared')",
        )) === true,
      "Saved run output survives reload",
      60000,
    );
    pass(
      "Run button submits synced code and stdin; shared output, exit code and history reach the viewer, survive reload and render HTML as plain text",
    );
  }
}

async function run() {
  assert.equal(
    await database.user.count({ where: { email: { in: emails } } }),
    0,
    "Generated identities must not exist before the test",
  );
  cleanupAllowed = true;
  for (const [index, name] of names.entries()) {
    const client = new HttpClient();
    clients.push(client);
    await client.request(
      "/api/auth/sign-up/email",
      "POST",
      authSignUpSchema.parse({
        name: `Browser ${name}`,
        email: emails[index],
        password,
      }),
    );
  }
  const owner = firstClient();
  const { project } = createdProjectResponseSchema.parse(
    await owner.request(
      "/api/projects",
      "POST",
      createProjectSchema.parse({ name: `Browser smoke ${runId.slice(0, 8)}` }),
    ),
  );
  createdProjects.push(project.id);
  for (const [index, client] of clients.entries()) {
    if (index === 0) continue;
    const { invite } = inviteResponseSchema.parse(
      await owner.request(
        `/api/projects/${project.id}/invites`,
        "POST",
        createInviteSchema.parse({
          role: index === 3 ? "VIEWER" : "EDITOR",
          expiresInDays: 1,
        }),
      ),
    );
    joinInviteResponseSchema.parse(
      await client.request(
        `/api/invites/${invite.code}/join`,
        "POST",
        emptyInputSchema.parse({}),
      ),
    );
  }
  const { item } = itemResponseSchema.parse(
    await owner.request(
      `/api/projects/${project.id}/items`,
      "POST",
      createItemSchema.parse({
        title: "Browser document",
        type: "PAGE",
        parentId: null,
      }),
    ),
  );
  await startBrowser();
  const url = `${baseUrl}/projects/${project.id}/${item.id}`;
  await openTab(owner, url);
  await focusParagraph(firstTab());
  await browser().send(
    "Input.insertText",
    { text: "Shared seed. " },
    firstTab().sessionId,
  );
  await waitUntil(
    async () => (await visibleText(firstTab())).includes("Shared seed."),
    "Real editor text insertion",
  );
  for (const client of clients.slice(1)) await openTab(client, url);
  await allTabs(
    "document.querySelector('[aria-label=\"4 people on this page\"]') !== null",
    "Four verified avatars",
  );
  pass(
    "four isolated accounts load the real BlockNote editor with four verified page avatars",
  );

  const writers = tabs.slice(0, 3);
  const tokens = ["AlphaBrowser ", "BravoBrowser ", "CharlieBrowser "];
  await Promise.all(writers.map((tab) => focusParagraph(tab)));
  await Promise.all(
    writers.map((tab, index) =>
      browser().send(
        "Input.insertText",
        { text: tokens[index] },
        tab.sessionId,
      ),
    ),
  );
  await waitUntil(async () => {
    const values = await Promise.all(tabs.map(visibleText));
    return (
      values.every((value) =>
        tokens.every((token) => value.includes(token.trim())),
      ) && new Set(values).size === 1
    );
  }, "Three real concurrent editor edits converge");
  pass(
    "three simultaneous browser editors converge without losing any text; the viewer receives the same result",
  );
  await verifyOfflineMerge();

  const viewer = tabs[3];
  assert.ok(viewer);
  assert.equal(
    await browser().evaluate(
      viewer,
      "document.querySelector('.bn-editor')?.getAttribute('contenteditable')",
    ),
    "false",
    "Viewer editor must be read-only",
  );
  assert.equal(
    await browser().evaluate(
      viewer,
      "Boolean(document.querySelector('[aria-label=\"Add page, code file or folder\"]'))",
    ),
    false,
    "Viewer tree write controls must be hidden",
  );
  await focusParagraph(viewer);
  await browser().send(
    "Input.insertText",
    { text: "ForbiddenViewerMutation" },
    viewer.sessionId,
  );
  await delay(300);
  assert.ok(
    (await Promise.all(tabs.map(visibleText))).every(
      (value) => !value.includes("ForbiddenViewerMutation"),
    ),
    "Viewer input must not edit the page",
  );
  pass(
    "viewer is read-only in the rendered editor and cannot insert text or see tree write controls",
  );

  await focusParagraph(firstTab(), true);
  await key(firstTab(), "Enter", "Enter", 13);
  await chooseSlash(firstTab(), "Heading 1");
  await browser().send(
    "Input.insertText",
    { text: "Collaborative heading" },
    firstTab().sessionId,
  );
  await allTabs(
    "document.querySelector('.bn-editor [data-content-type=heading]')?.textContent.includes('Collaborative heading') === true",
    "Collaborative heading block",
  );
  await key(firstTab(), "Enter", "Enter", 13);
  await chooseSlash(firstTab(), "Table");
  await allTabs(
    "Boolean(document.querySelector('.bn-editor table'))",
    "Collaborative table block",
  );
  pass(
    "slash menu creates heading and table blocks that render in every browser",
  );

  const sidebarTitle = `Live sidebar ${runId.slice(0, 8)}`;
  const { item: sidebarPage } = itemResponseSchema.parse(
    await owner.request(
      `/api/projects/${project.id}/items`,
      "POST",
      createItemSchema.parse({
        title: sidebarTitle,
        type: "PAGE",
        parentId: null,
      }),
    ),
  );
  const sidebarHref = `/projects/${project.id}/${sidebarPage.id}`;
  await allTabs(
    `document.querySelector('a[href="${sidebarHref}"]')?.textContent.includes(${JSON.stringify(sidebarTitle)}) === true`,
    "Sidebar create broadcasts",
  );
  itemResponseSchema.parse(
    await owner.request(
      `/api/projects/${project.id}/items/${sidebarPage.id}`,
      "PATCH",
      updateItemSchema.parse({
        action: "rename",
        title: `${sidebarTitle} renamed`,
      }),
    ),
  );
  await allTabs(
    `document.querySelector('a[href="${sidebarHref}"]')?.textContent.includes('renamed') === true`,
    "Sidebar rename broadcasts",
  );
  const { item: folder } = itemResponseSchema.parse(
    await owner.request(
      `/api/projects/${project.id}/items`,
      "POST",
      createItemSchema.parse({
        title: "Live folder",
        type: "FOLDER",
        parentId: null,
      }),
    ),
  );
  itemResponseSchema.parse(
    await owner.request(
      `/api/projects/${project.id}/items/${sidebarPage.id}`,
      "PATCH",
      updateItemSchema.parse({ action: "move", parentId: folder.id, index: 0 }),
    ),
  );
  await allTabs(
    `document.querySelector('a[href="${sidebarHref}"]')?.closest('li')?.parentElement?.closest('li')?.textContent.includes('Live folder') === true`,
    "Sidebar nesting broadcasts",
  );
  deleteItemsResponseSchema.parse(
    await owner.request(
      `/api/projects/${project.id}/items/${folder.id}`,
      "DELETE",
      emptyInputSchema.parse({}),
    ),
  );
  await allTabs(
    `document.querySelector('a[href="${sidebarHref}"]') === null`,
    "Sidebar subtree delete broadcasts",
  );
  pass(
    "create, rename, nest and subtree delete update all four sidebars without reloading pages",
  );

  await allTabs(
    "document.querySelector('[aria-label=\"Collaborative page\"]')?.textContent.includes('All changes synced') === true",
    "Browser edits acknowledged",
  );
  const persisted = await visibleText(firstTab());
  await browser().send(
    "Page.reload",
    { ignoreCache: true },
    firstTab().sessionId,
  );
  await waitUntil(
    async () => (await visibleText(firstTab())) === persisted,
    "Browser reload preserves the page",
    60_000,
  );
  if (checkChat) await verifyChat(project.id);
  if (checkPresence) await verifyProjectPresence(project.id, item.id);
  if (checkCode) await verifyCodeEditor(project.id);
  assert.ok(
    !browser().exceptions.length,
    `Browser runtime errors: ${browser().exceptions.join(", ")}`,
  );
  assert.ok(
    !browser().consoleErrors.length,
    `Browser console errors: ${browser().consoleErrors.join("\n")}`,
  );
  assert.ok(
    !browser().consoleWarnings.length,
    `Browser console warnings: ${browser().consoleWarnings.join("\n")}`,
  );
  pass(
    checkCode
      ? "Page and code acceptance checks finish with zero browser runtime errors, console errors or warnings"
      : "reloading the real page restores text, heading and table with no browser runtime errors or console warnings",
  );
  const screenshot = record(
    await browser().send(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false },
      firstTab().sessionId,
    ),
  );
  const screenshotPath = resolve(
    artifactDirectory,
    checkCode ? "verified-code.png" : "verified-page.png",
  );
  await writeFile(
    screenshotPath,
    Buffer.from(string(screenshot.data), "base64"),
  );
  console.log(`Browser screenshot: ${screenshotPath}`);
}

async function captureFailure() {
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(
    resolve(artifactDirectory, "browser-stderr.txt"),
    `${browserFailure}\nBrowser exit code: ${browserProcess?.exitCode ?? "running"}\n`,
  );
  if (!devtools) return;
  await writeFile(
    resolve(artifactDirectory, "browser-console.txt"),
    [
      ...devtools.exceptions,
      ...devtools.consoleErrors,
      ...devtools.consoleWarnings,
    ].join("\n"),
  );
  for (const [index, tab] of tabs.entries()) {
    try {
      const screenshot = record(
        await devtools.send(
          "Page.captureScreenshot",
          { format: "png", captureBeyondViewport: false },
          tab.sessionId,
        ),
      );
      await writeFile(
        resolve(artifactDirectory, `failure-${index}.png`),
        Buffer.from(string(screenshot.data), "base64"),
      );
      const body = string(
        await devtools.evaluate(tab, "document.body?.innerText ?? ''"),
      );
      await writeFile(resolve(artifactDirectory, `failure-${index}.txt`), body);
    } catch {
      /* A crashed target cannot supply a screenshot. */
    }
  }
  console.error(`Browser diagnostics: ${artifactDirectory}`);
}

try {
  await run();
} catch (error) {
  process.exitCode = 1;
  console.error(
    error instanceof Error ? error.message : "Browser smoke failed",
  );
  await captureFailure();
} finally {
  if (devtools) {
    await devtools.send("Browser.close").catch(() => undefined);
    devtools.socket.close();
  }
  browserProcess?.kill();
  if (cleanupAllowed) {
    await database.project.deleteMany({
      where: { id: { in: createdProjects }, owner: { email: { in: emails } } },
    });
    await database.user.deleteMany({ where: { email: { in: emails } } });
  }
  await database.$disconnect();
}
