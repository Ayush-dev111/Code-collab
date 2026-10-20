import { test, expect, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { getDatabase } from "@collab/db";
import {
  createdProjectResponseSchema,
  itemResponseSchema,
} from "@collab/shared";

async function noHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
}

test("appearance follows the system, persists an explicit choice and syncs between tabs", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/login");
  await expect(
    page.getByRole("button", { name: "System theme", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Dark theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(16, 21, 28)",
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Dark theme", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const second = await context.newPage();
  await second.goto("/login");
  await expect(second.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Light theme", exact: true }).click();
  await expect(second.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "System theme", exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await noHorizontalOverflow(page);
  }
  await page.screenshot({
    path: "../../.tools/ui-preview/login-light.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Dark theme", exact: true }).click();
  await page.screenshot({
    path: "../../.tools/ui-preview/login-dark.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("project filters, layouts, mobile panels and editor themes work together", async ({
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Missing local test URL");
  const db = getDatabase();
  const prefix = `ui-${randomUUID()}`;
  const emails = ["owner", "teammate"].map(
    (role) => `${prefix}-${role}@example.test`,
  );
  const password = `Ui-${randomBytes(24).toString("hex")}`;
  const owner = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const teammate = await browser.newContext();
  const projectIds: string[] = [];
  const errors: string[] = [];
  try {
    let ownerId = "";
    for (const [index, context] of [owner, teammate].entries()) {
      const response = await context.request.post(
        `${baseURL}/api/auth/sign-up/email`,
        {
          headers: { Origin: baseURL },
          data: {
            name: index === 0 ? "Jamie Parker" : "Morgan Lee",
            email: emails[index],
            password,
          },
        },
      );
      expect(response.status()).toBe(200);
      const data = (await response.json()) as { user: { id: string } };
      if (index === 0) ownerId = data.user.id;
    }
    for (const [index, name] of [
      "Brand explorations",
      "Product launch",
      "Team playbook",
    ].entries()) {
      const context = index < 2 ? owner : teammate;
      const response = await context.request.post(`${baseURL}/api/projects`, {
        headers: { Origin: baseURL },
        data: { name },
      });
      expect(response.status()).toBe(201);
      const project = createdProjectResponseSchema.parse(
        await response.json(),
      ).project;
      projectIds.push(project.id);
      if (index === 2)
        await db.projectMember.create({
          data: { projectId: project.id, userId: ownerId, role: "EDITOR" },
        });
    }
    const page = await owner.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseURL}/projects`);
    await expect(page.locator(".project-card")).toHaveCount(3);
    await page.getByRole("button", { name: /^My projects/ }).click();
    await expect(page.locator(".project-card")).toHaveCount(2);
    await page.getByRole("button", { name: /^Shared with me/ }).click();
    await expect(page.locator(".project-card")).toHaveCount(1);
    await expect(page.locator(".project-card")).toContainText("Team playbook");
    await page.getByRole("button", { name: /^All projects/ }).click();
    await page.getByRole("textbox", { name: "Search projects" }).fill("launch");
    await expect(page.locator(".project-card")).toHaveCount(1);
    await expect(page.locator(".project-card")).toContainText("Product launch");
    await page
      .getByRole("textbox", { name: "Search projects" })
      .fill("unmatched");
    await expect(
      page.getByRole("heading", { name: "No projects found" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.locator(".project-card")).toHaveCount(3);
    await page.getByRole("button", { name: "List view", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "List view", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    for (const width of [320, 375, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await noHorizontalOverflow(page);
    }
    await page.getByRole("button", { name: "Grid view", exact: true }).click();
    await page
      .getByRole("button", { name: "Light theme", exact: true })
      .click();
    await page.screenshot({
      path: "../../.tools/ui-preview/projects-light.png",
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Dark theme", exact: true }).click();
    await page.screenshot({
      path: "../../.tools/ui-preview/projects-dark.png",
      fullPage: true,
      animations: "disabled",
    });
    await expect(page.locator(".project-card").first()).toHaveCSS(
      "background-color",
      "rgb(23, 30, 39)",
    );
    await page.setViewportSize({ width: 375, height: 900 });
    await page.screenshot({
      path: "../../.tools/ui-preview/projects-mobile.png",
      fullPage: true,
      animations: "disabled",
    });
    await page
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${baseURL}/projects/${projectIds[0]}`);
    await expect(
      page.getByRole("heading", { name: "Brand explorations", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "../../.tools/ui-preview/workspace-dark.png",
      fullPage: true,
      animations: "disabled",
    });
    await page
      .getByRole("button", { name: "Light theme", exact: true })
      .click();
    await page.screenshot({
      path: "../../.tools/ui-preview/workspace-light.png",
      fullPage: true,
      animations: "disabled",
    });
    const panels = await Promise.all(
      [
        "#panel-files > aside",
        "#panel-workspace > section",
        "#panel-chat > aside",
      ].map((selector) => page.locator(selector).boundingBox()),
    );
    expect(panels.every((panel) => panel !== null)).toBe(true);
    const bottoms = panels.map((panel) => panel!.y + panel!.height);
    expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThan(2);
    for (const width of [320, 375, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await noHorizontalOverflow(page);
      await page
        .getByRole("button", { name: "Files & team", exact: true })
        .click();
      await expect(
        page.getByRole("complementary", { name: "Project sidebar" }),
      ).toBeVisible();
      await noHorizontalOverflow(page);
      await page
        .getByRole("button", { name: "Team chat", exact: true })
        .click();
      await expect(
        page.getByRole("textbox", { name: "Message your team" }),
      ).toBeVisible();
      await page
        .getByRole("textbox", { name: "Message your team" })
        .fill("Draft retained between panels");
      await page
        .getByRole("button", { name: "Workspace", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Team chat", exact: true })
        .click();
      await expect(
        page.getByRole("textbox", { name: "Message your team" }),
      ).toHaveValue("Draft retained between panels");
      await noHorizontalOverflow(page);
    }
    await page.setViewportSize({ width: 375, height: 900 });
    await page.screenshot({
      path: "../../.tools/ui-preview/chat-mobile.png",
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const docResponse = await owner.request.post(
      `${baseURL}/api/projects/${projectIds[0]}/items`,
      {
        headers: { Origin: baseURL },
        data: { type: "PAGE", title: "Project notes" },
      },
    );
    expect(docResponse.status()).toBe(201);
    const doc = itemResponseSchema.parse(await docResponse.json()).item;
    await page.goto(`${baseURL}/projects/${projectIds[0]}/${doc.id}`);
    await expect(page.locator(".bn-editor")).toBeVisible();
    await page.setViewportSize({ width: 375, height: 900 });
    await page
      .getByRole("button", { name: "Files & team", exact: true })
      .click();
    await page
      .getByRole("list", { name: "Project pages, code files and folders" })
      .getByRole("link", { name: "Project notes", exact: true })
      .click();
    await expect(page.locator(".bn-editor")).toBeVisible();
    await noHorizontalOverflow(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "Dark theme", exact: true }).click();
    await expect(page.locator(".bn-editor")).toHaveCSS(
      "background-color",
      "rgb(23, 30, 39)",
    );
    await page.screenshot({
      path: "../../.tools/ui-preview/document-dark.png",
      fullPage: true,
      animations: "disabled",
    });
    const codeResponse = await owner.request.post(
      `${baseURL}/api/projects/${projectIds[0]}/items`,
      {
        headers: { Origin: baseURL },
        data: { type: "CODE", title: "hello.js", language: "javascript" },
      },
    );
    expect(codeResponse.status()).toBe(201);
    const code = itemResponseSchema.parse(await codeResponse.json()).item;
    await page.goto(`${baseURL}/projects/${projectIds[0]}/${code.id}`);
    await expect(
      page.getByRole("combobox", { name: "Code editor appearance" }),
    ).toHaveValue("system");
    await expect(page.locator(".monaco-editor.vs-dark")).toBeVisible();
    await page
      .getByRole("button", { name: "Light theme", exact: true })
      .click();
    await expect(page.locator(".monaco-editor.vs")).toBeVisible();
    await page
      .getByRole("combobox", { name: "Code editor appearance" })
      .selectOption("vs-dark");
    await expect(page.locator(".monaco-editor.vs-dark")).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("combobox", { name: "Code editor appearance" }),
    ).toHaveValue("vs-dark");
    await expect(page.locator(".monaco-editor.vs-dark")).toBeVisible();
    await page.screenshot({
      path: "../../.tools/ui-preview/code-editor.png",
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 320, height: 900 });
    await noHorizontalOverflow(page);
    await page.screenshot({
      path: "../../.tools/ui-preview/code-mobile.png",
      fullPage: true,
      animations: "disabled",
    });
    expect(errors).toEqual([]);
  } finally {
    await owner.close();
    await teammate.close();
    await db.project.deleteMany({
      where: { id: { in: projectIds }, owner: { email: { in: emails } } },
    });
    await db.user.deleteMany({ where: { email: { in: emails } } });
  }
});
