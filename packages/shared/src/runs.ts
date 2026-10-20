import { z } from "zod";
import { projectIdSchema } from "./projects.js";
import { itemIdSchema } from "./items.js";
import { codeStdinSchema } from "./code.js";

// Judge0 CE 1.13.1's single-file runtimes. Syntax highlighting supports more
// languages; execution only enables the explicitly supported sandbox runtimes.
export const executableLanguageSchema = z.enum([
  "python",
  "javascript",
  "cpp",
  "java",
]);
export const judge0LanguageIds = {
  python: 71,
  javascript: 63,
  cpp: 54,
  java: 62,
} as const;
export const MAX_SOURCE_BYTES = 64 * 1024;
export const MAX_RUN_OUTPUT_BYTES = 16 * 1024;
export const RUN_DEADLINE_MS = 30_000;
export const RUN_LEASE_MS = 65_000;
export const runLimitResponseSchema = z.tuple([
  z.union([z.literal(0), z.literal(1), z.literal(2)]),
  z.number().int().min(0).max(RUN_LEASE_MS),
]);
export const runInputSchema = z.strictObject({
  projectId: projectIdSchema,
  itemId: itemIdSchema,
  language: executableLanguageSchema,
  sourceCode: z
    .string()
    .min(1)
    .max(MAX_SOURCE_BYTES)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= MAX_SOURCE_BYTES,
      "Code must be at most 64 KiB.",
    ),
  stdin: codeStdinSchema
    .default("")
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= 16 * 1024,
      "Standard input must be at most 16 KiB.",
    ),
});
export const runStatusSchema = z.enum(["RUNNING", "FINISHED", "FAILED"]);
export const runSchema = z.object({
  id: z.cuid(),
  itemId: itemIdSchema,
  userId: z.string().min(1).max(128),
  userName: z.string().min(1).max(80),
  language: z.string().min(1).max(128),
  status: runStatusSchema,
  statusLabel: z.string().max(200),
  stdout: z.string().max(MAX_RUN_OUTPUT_BYTES).nullable(),
  stderr: z.string().max(MAX_RUN_OUTPUT_BYTES).nullable(),
  compileOutput: z.string().max(MAX_RUN_OUTPUT_BYTES).nullable(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().min(0).nullable(),
  judge0Status: z.number().int().min(1).max(14).nullable(),
  outputTruncated: z.boolean(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export const runResponseSchema = z.object({
  run: runSchema,
  notificationPending: z.boolean().optional(),
});
export const runHistoryQuerySchema = z.strictObject({
  before: z.cuid().optional(),
});
export const runHistoryResponseSchema = z.object({
  runs: z.array(runSchema).max(20),
  nextCursor: z.cuid().nullable(),
});
export const runEventSchema = z.strictObject({
  projectId: projectIdSchema,
  itemId: itemIdSchema,
  runId: z.cuid(),
  changedAt: z.iso.datetime(),
});
export const runNotificationSchema = z.strictObject({
  projectId: projectIdSchema,
  runId: z.cuid(),
  event: z.enum(["run:started", "run:finished"]),
});
export const runnerEnvironmentSchema = z.object({
  JUDGE0_URL: z.url({ protocol: /^https?$/ }).refine((value) => {
    try {
      const url = new URL(value);
      return (
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/" &&
        (url.protocol === "https:" ||
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      );
    } catch {
      return false;
    }
  }, "Use HTTPS or a loopback HTTP origin for Judge0."),
  JUDGE0_AUTH_TOKEN: z
    .string()
    .min(32)
    .max(256)
    .regex(/^[a-zA-Z0-9_-]+$/),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
});
export const judge0CreatedSchema = z.object({ token: z.uuid() });
export const judge0LanguagesSchema = z
  .array(
    z.object({
      id: z.number().int().positive(),
      name: z.string().min(1).max(200),
    }),
  )
  .max(200);
export const judge0ResultSchema = z.object({
  status: z.object({
    id: z.number().int().min(1).max(14),
    description: z.string().max(200),
  }),
  stdout: z.string().max(100_000).nullable().optional(),
  stderr: z.string().max(100_000).nullable().optional(),
  compile_output: z.string().max(100_000).nullable().optional(),
  exit_code: z.number().int().nullable().optional(),
  time: z
    .string()
    .max(32)
    .regex(/^\d+(\.\d+)?$/)
    .nullable()
    .optional(),
});
export type RunInput = z.infer<typeof runInputSchema>;
export type CodeRun = z.infer<typeof runSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunNotification = z.infer<typeof runNotificationSchema>;
export type RunnerEnvironment = z.infer<typeof runnerEnvironmentSchema>;
export type Judge0Result = z.infer<typeof judge0ResultSchema>;
