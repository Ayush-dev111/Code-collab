import assert from "node:assert/strict";
import * as Sentry from "@sentry/node";
import {
  privateMonitoringOptions,
  monitoringDsnSchema,
  rateLimitEnvironmentSchema,
} from "@collab/shared";

for (const invalid of [
  "",
  "invalid",
  "http://public-key@example.test/1",
  "https://key:secret@example.test/1",
])
  assert.equal(monitoringDsnSchema.safeParse(invalid).success, false);
assert.equal(
  rateLimitEnvironmentSchema.safeParse({ REDIS_URL: "" }).success,
  false,
);
import { structuredLog } from "../dist/index.js";
const envelopes: unknown[] = [];
Sentry.init({
  dsn: "https://testkey@example.invalid/1",
  environment: "phase8-test",
  defaultIntegrations: false,
  ...privateMonitoringOptions,
  transport: () => ({
    send: async (envelope) => {
      envelopes.push(envelope);
      return { statusCode: 200 };
    },
    flush: async () => true,
  }),
});
const sensitive = "phase8-secret-content-cookie-password-token";
Sentry.captureEvent({
  message: sensitive,
  user: { email: sensitive, ip_address: sensitive },
  request: {
    url: `https://example.test/?token=${sensitive}`,
    headers: { Cookie: sensitive },
    data: sensitive,
  },
  extra: { sourceCode: sensitive },
  breadcrumbs: [{ message: sensitive }],
  exception: {
    values: [
      {
        type: "TypeError",
        value: sensitive,
        stacktrace: {
          frames: [
            {
              filename: `https://example.test/app.ts?token=${sensitive}`,
              lineno: 12,
              colno: 4,
              function: "submit",
            },
          ],
        },
      },
    ],
  },
});
await Sentry.flush(2000);
assert.ok(
  envelopes.length > 0,
  "The SDK must deliver an event to its test transport",
);
assert.ok(!JSON.stringify(envelopes).includes(sensitive));
assert.ok(JSON.stringify(envelopes).includes("Unexpected application error"));
assert.ok(JSON.stringify(envelopes).includes('"environment":"phase8-test"'));
const lines: string[] = [];
const original = console.info;
console.info = (value: unknown) => lines.push(String(value));
try {
  structuredLog("test", "info", "request.completed", {
    status: 200,
    durationMs: 12,
  });
} finally {
  console.info = original;
}
assert.equal(JSON.parse(lines[0]!).event, "request.completed");
assert.ok(!JSON.stringify(lines).includes(sensitive));
await Sentry.close();
console.log(
  "PASS actual Sentry transport strips private data, keeps stack locations, and structured logs contain only allowed metadata",
);
