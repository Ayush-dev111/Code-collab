import { test } from "node:test";
import assert from "node:assert/strict";
import { consumeRateLimit, RateLimitError } from "@/lib/rate-limit";
import { hasMinimumRole, safeLinkUrl } from "@/lib/shared";

test("roles are ordered viewer < editor < owner", () => {
  assert.equal(hasMinimumRole("OWNER", "EDITOR"), true);
  assert.equal(hasMinimumRole("EDITOR", "EDITOR"), true);
  assert.equal(hasMinimumRole("VIEWER", "EDITOR"), false);
});

test("rate limits count per user and project, then reset", () => {
  const now = 1_000_000;
  for (let i = 0; i < 6; i++)
    consumeRateLimit("run", "user-a", "project-a", now);
  assert.throws(
    () => consumeRateLimit("run", "user-a", "project-a", now),
    RateLimitError,
  );
  // Another user still has their own allowance in the same project.
  consumeRateLimit("run", "user-b", "project-a", now);
  // The window resets after a minute.
  consumeRateLimit("run", "user-a", "project-a", now + 60_001);
});

test("a rejected action does not use up another scope's allowance", () => {
  const now = 2_000_000;
  // Fill the project allowance (20) with several users.
  for (let i = 0; i < 20; i++)
    consumeRateLimit("run", `filler-${i % 4}`, "project-b", now);
  assert.throws(() => consumeRateLimit("run", "user-c", "project-b", now));
  // user-c was not charged, so it can still run in another project.
  for (let i = 0; i < 6; i++)
    consumeRateLimit("run", "user-c", "project-c", now);
});

test("only safe links are allowed in pages", () => {
  assert.equal(safeLinkUrl("https://example.com"), "https://example.com");
  assert.equal(safeLinkUrl("/projects/abc"), "/projects/abc");
  assert.equal(safeLinkUrl("mailto:a@example.com"), "mailto:a@example.com");
  assert.equal(safeLinkUrl("javascript:alert(1)"), undefined);
  assert.equal(safeLinkUrl("//evil.example"), undefined);
  assert.equal(safeLinkUrl("https://user:pass@example.com"), undefined);
});
