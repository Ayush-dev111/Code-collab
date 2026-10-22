import { z } from "zod";
import {
  MAX_RUN_OUTPUT_BYTES,
  RUN_DEADLINE_MS,
  type RunInput,
} from "@/lib/shared";
import { ApiError } from "./api";

// Code runs on Paiza.io's free hosted sandbox (https://paiza.io), never on
// this server. Without PAIZA_API_KEY the public "guest" key is used, which
// suits light use. Paiza stops programs that run longer than a few seconds.
const API_URL = "https://api.paiza.io/runners";
const languages = {
  python: "python3",
  javascript: "javascript",
  cpp: "cpp",
  java: "java",
} as const;

const createdSchema = z.object({ id: z.string().min(1).max(100) });
const optionalText = z.string().nullish();
// Paiza sends exit codes as strings once a run completes ("0").
const exitCode = z.union([z.number(), z.string()]).nullish();
const detailsSchema = z.object({
  status: z.string(),
  result: optionalText,
  stdout: optionalText,
  stderr: optionalText,
  exit_code: exitCode,
  time: optionalText,
  build_result: optionalText,
  build_stdout: optionalText,
  build_stderr: optionalText,
  build_exit_code: exitCode,
});
type RunDetails = z.infer<typeof detailsSchema>;

function toInteger(value: number | string | null | undefined) {
  const number = Number(value);
  return value === null ||
    value === undefined ||
    value === "" ||
    !Number.isSafeInteger(number)
    ? null
    : number;
}

const runnerError = (message: string) =>
  new ApiError(502, "RUNNER_ERROR", message);

async function paiza(
  path: "create" | "get_details",
  params: Record<string, string>,
  signal: AbortSignal,
) {
  const query = new URLSearchParams({
    ...params,
    api_key: process.env.PAIZA_API_KEY || "guest",
  });
  const create = path === "create";
  const response = await fetch(
    create ? `${API_URL}/create` : `${API_URL}/${path}?${query}`,
    {
      method: create ? "POST" : "GET",
      ...(create ? { body: query } : {}),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      redirect: "error",
      cache: "no-store",
    },
  );
  const text = await response.text();
  if (!response.ok || text.length > 512 * 1024)
    throw runnerError(
      response.status === 429
        ? "The execution service is busy. Try again in a minute."
        : "The execution service could not process this run.",
    );
  return JSON.parse(text) as unknown;
}

function capped(value: string | null | undefined) {
  if (!value) return { text: null, truncated: false };
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= MAX_RUN_OUTPUT_BYTES)
    return { text: value, truncated: false };
  // TextDecoder drops an incomplete UTF-8 sequence at the cut.
  const text = new TextDecoder().decode(
    bytes.subarray(0, MAX_RUN_OUTPUT_BYTES),
    { stream: true },
  );
  return { text, truncated: true };
}

const resultLabels: Record<string, string> = {
  success: "Accepted",
  failure: "Runtime Error",
  timeout: "Time Limit Exceeded",
};

function runFields(details: RunDetails) {
  const built = !details.build_result || details.build_result === "success";
  const stdout = capped(details.stdout);
  const stderr = capped(details.stderr);
  const compileOutput = capped(
    built
      ? null
      : [details.build_stdout, details.build_stderr].filter(Boolean).join("\n"),
  );
  const seconds = Number(details.time);
  return {
    status:
      built && details.result === "success"
        ? ("FINISHED" as const)
        : ("FAILED" as const),
    statusLabel: built
      ? (resultLabels[details.result ?? ""] ?? "Execution error")
      : "Compilation Error",
    stdout: stdout.text,
    stderr: stderr.text,
    compileOutput: compileOutput.text,
    exitCode: toInteger(built ? details.exit_code : details.build_exit_code),
    durationMs:
      details.time && Number.isFinite(seconds)
        ? Math.round(seconds * 1000)
        : null,
    outputTruncated:
      stdout.truncated || stderr.truncated || compileOutput.truncated,
    finishedAt: new Date(),
  };
}

export async function runCode(input: RunInput, signal: AbortSignal) {
  const created = createdSchema.safeParse(
    await paiza(
      "create",
      {
        source_code: input.sourceCode,
        language: languages[input.language],
        input: input.stdin,
      },
      signal,
    ),
  );
  if (!created.success)
    throw runnerError("The execution service returned an invalid response.");
  const deadline = Date.now() + RUN_DEADLINE_MS;
  for (;;) {
    const details = detailsSchema.safeParse(
      await paiza("get_details", { id: created.data.id }, signal),
    );
    if (!details.success)
      throw runnerError("The execution service returned an invalid response.");
    if (details.data.status === "completed") return runFields(details.data);
    if (Date.now() > deadline)
      throw new ApiError(
        504,
        "RUNNER_TIMEOUT",
        "The execution service did not finish within 30 seconds.",
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
