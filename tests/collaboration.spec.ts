import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { getDatabase } from "@/lib/db";
import {
  createdProjectResponseSchema,
  inviteResponseSchema,
  itemResponseSchema,
} from "@/lib/shared";

test("two editors converge, a network drop loses no text, and a viewer receives chat but cannot write", async ({
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Missing test URL");
  const origin = baseURL;
  const db = getDatabase();
  const prefix = `e2e-${randomUUID()}`;
  const emails = ["owner", "editor"].map(
    (role) => `${prefix}-${role}@example.test`,
  );
  const password = `E2e-${randomBytes(24).toString("hex")}`;
  const contexts: BrowserContext[] = [];
  const projectIds: string[] = [];
  const errors: string[] = [];
  async function signup(context: BrowserContext, index: number) {
    for (let attempt = 0; ; attempt += 1) {
      const response = await context.request.post(
        `${baseURL}/api/auth/sign-up/email`,
        {
          headers: { Origin: origin },
          data: {
            name: `Playwright ${index === 0 ? "owner" : "editor"}`,
            email: emails[index],
            password,
          },
        },
      );
      if (response.status() === 429 && attempt < 3) {
        const seconds = Number(
          response.headers()["retry-after"] ??
            response.headers()["x-retry-after"],
        );
        expect(seconds).toBeLessThanOrEqual(30);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(1, seconds) * 1000 + 100),
        );
        continue;
      }
      expect(response.status()).toBe(200);
      break;
    }
  }
  function observe(page: Page) {
    page.on("pageerror", (error) => errors.push(error.name));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        !message.text().includes("net::ERR_INTERNET_DISCONNECTED")
      )
        errors.push(message.text());
    });
  }
  function text(page: Page) {
    return page.locator(".bn-editor");
  }
  async function documentText(page: Page) {
    return text(page).evaluate((element) => {
      const clone = element.cloneNode(true) as HTMLElement;
      clone
        .querySelectorAll(
          ".bn-collaboration-cursor__base,.ProseMirror-yjs-cursor",
        )
        .forEach((cursor) => cursor.remove());
      return (clone.textContent ?? "").replaceAll("\u2060", "");
    });
  }
  async function paragraph(page: Page) {
    const element = page
      .locator('.bn-editor [data-content-type="paragraph"] p')
      .first();
    await element.click();
    await page.keyboard.press("End");
  }
  try {
    const ownerContext = await browser.newContext();
    const editorContext = await browser.newContext();
    contexts.push(ownerContext, editorContext);
    await signup(ownerContext, 0);
    await signup(editorContext, 1);
    const projectResponse = await ownerContext.request.post(
      `${baseURL}/api/projects`,
      {
        headers: { Origin: baseURL },
        data: { name: `Playwright ${prefix.slice(-36)}` },
      },
    );
    expect(projectResponse.status()).toBe(201);
    const project = createdProjectResponseSchema.parse(
      await projectResponse.json(),
    ).project;
    projectIds.push(project.id);
    const inviteResponse = await ownerContext.request.post(
      `${baseURL}/api/projects/${project.id}/invites`,
      {
        headers: { Origin: baseURL },
        data: { role: "EDITOR", expiresInDays: 1 },
      },
    );
    expect(inviteResponse.status()).toBe(201);
    const invite = inviteResponseSchema.parse(
      await inviteResponse.json(),
    ).invite;
    expect(
      (
        await editorContext.request.post(
          `${baseURL}/api/invites/${invite.code}/join`,
          { headers: { Origin: baseURL }, data: {} },
        )
      ).status(),
    ).toBe(200);
    const itemResponse = await ownerContext.request.post(
      `${baseURL}/api/projects/${project.id}/items`,
      {
        headers: { Origin: baseURL },
        data: { type: "PAGE", title: "Playwright page" },
      },
    );
    expect(itemResponse.status()).toBe(201);
    const item = itemResponseSchema.parse(await itemResponse.json()).item;
    const owner = await ownerContext.newPage();
    const editor = await editorContext.newPage();
    observe(owner);
    observe(editor);
    const url = `${baseURL}/projects/${project.id}/${item.id}`;
    await owner.goto(url);
    await expect(owner.getByLabel("Collaborative page")).toContainText(
      "All changes synced",
    );
    await paragraph(owner);
    await owner.keyboard.insertText("Seed ");
    await editor.goto(url);
    await expect(text(editor)).toContainText("Seed");
    await Promise.all([paragraph(owner), paragraph(editor)]);
    await Promise.all([
      owner.keyboard.insertText("AlphaConcurrent "),
      editor.keyboard.insertText("BravoConcurrent "),
    ]);
    for (const page of [owner, editor]) {
      await expect(text(page)).toContainText("AlphaConcurrent");
      await expect(text(page)).toContainText("BravoConcurrent");
    }
    await owner
      .getByLabel("Message your team")
      .fill("Retained offline chat draft");
    await ownerContext.setOffline(true);
    await expect(
      owner.getByRole("status").filter({ hasText: "You’re offline" }),
    ).toBeVisible();
    await expect(
      owner.getByRole("button", { name: "Send", exact: true }),
    ).toBeDisabled();
    await paragraph(owner);
    await owner.keyboard.insertText("OfflineKeep ");
    await paragraph(editor);
    await editor.keyboard.insertText("OnlineKeep ");
    await editor
      .getByLabel("Message your team")
      .fill("Chat while peer offline");
    await editor.getByRole("button", { name: "Send", exact: true }).click();
    await expect(text(editor)).not.toContainText("OfflineKeep");
    await ownerContext.setOffline(false);
    for (const page of [owner, editor]) {
      await expect(text(page)).toContainText("OfflineKeep");
      await expect(text(page)).toContainText("OnlineKeep");
      await expect(page.getByLabel("Collaborative page")).toContainText(
        "All changes synced",
      );
    }
    await expect(owner.getByLabel("Message your team")).toHaveValue(
      "Retained offline chat draft",
    );
    await expect(owner.getByLabel("Chat messages")).toContainText(
      "Chat while peer offline",
    );
    await owner.getByRole("button", { name: "Send", exact: true }).click();
    await expect(editor.getByLabel("Chat messages")).toContainText(
      "Retained offline chat draft",
    );
    await expect
      .poll(async () => documentText(owner))
      .toEqual(await documentText(editor));
    await owner.reload();
    await expect(text(owner)).toContainText("OfflineKeep");
    await expect(text(owner)).toContainText("OnlineKeep");
    await paragraph(owner);
    await text(owner).evaluate((element) => {
      const clipboard = new DataTransfer();
      clipboard.setData(
        "text/html",
        '<p><a href="javascript:window.phase8Injected=true">Untrusted pasted link</a></p>',
      );
      clipboard.setData("text/plain", "Untrusted pasted link");
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      );
    });
    await expect(text(owner)).toContainText("Untrusted pasted link");
    await expect(text(owner).locator('a[href^="javascript:"]')).toHaveCount(0);
    expect(
      await owner.evaluate(() => Reflect.get(window, "phase8Injected")),
    ).toBeUndefined();
    const first =
      "Playwright shared chat <script>window.phase8Injected=true</script>";
    await owner.getByLabel("Message your team").fill(first);
    await owner.getByRole("button", { name: "Send", exact: true }).click();
    await expect(editor.getByLabel("Chat messages")).toContainText(first);
    expect(
      await editor.evaluate(() => Reflect.get(window, "phase8Injected")),
    ).toBeUndefined();
    const account = await db.user.findUniqueOrThrow({
      where: { email: emails[1]! },
    });
    await db.projectMember.update({
      where: {
        projectId_userId: { projectId: project.id, userId: account.id },
      },
      data: { role: "VIEWER" },
    });
    await editor.reload();
    await expect(
      editor.getByText("You have read-only chat access."),
    ).toBeVisible();
    await expect(editor.getByLabel("Message your team")).toHaveCount(0);
    await expect(
      editor.locator('.bn-editor[contenteditable="false"]'),
    ).toBeVisible();
    const before = await text(editor).innerText();
    await text(editor).click();
    await editor.keyboard.insertText("FORBIDDEN_VIEWER_EDIT");
    expect(await text(editor).innerText()).toBe(before);
    const denied = await editorContext.request.patch(
      `${baseURL}/api/projects/${project.id}/items/${item.id}`,
      { headers: { Origin: baseURL }, data: { title: "Viewer attack" } },
    );
    expect(denied.status()).toBe(403);
    await owner.getByLabel("Message your team").fill("Viewer can read this");
    await owner.getByRole("button", { name: "Send", exact: true }).click();
    await expect(editor.getByLabel("Chat messages")).toContainText(
      "Viewer can read this",
    );
    await editor.reload();
    await expect(editor.getByLabel("Chat messages")).toContainText(first);
    await expect(editor.getByLabel("Chat messages")).toContainText(
      "Viewer can read this",
    );
    expect(errors).toEqual([]);
  } finally {
    for (const context of contexts) await context.close();
    await db.project.deleteMany({
      where: { id: { in: projectIds }, owner: { email: { in: emails } } },
    });
    await db.user.deleteMany({ where: { email: { in: emails } } });
    await db.$disconnect();
  }
});
