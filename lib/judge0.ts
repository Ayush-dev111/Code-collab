import {
  judge0CreatedSchema,
  judge0LanguageIds,
  judge0ResultSchema,
  MAX_RUN_OUTPUT_BYTES,
  RUN_DEADLINE_MS,
  type Judge0Result,
  type RunInput,
} from "@/lib/shared";
import { ApiError } from "./api";

type Judge0Config = { base: URL; headers: Record<string, string> };

// JUDGE0_URL is any Judge0 CE endpoint, for example the hosted
// https://judge0-ce.p.rapidapi.com. JUDGE0_API_KEY is sent as a RapidAPI key
// for RapidAPI hosts and as X-Auth-Token for every other host.
export function judge0Configuration(): Judge0Config {
  const raw = process.env.JUDGE0_URL?.trim();
  const key = process.env.JUDGE0_API_KEY?.trim();
  const unavailable = (message: string) =>
    new ApiError(503, "RUNNER_UNAVAILABLE", message);
  if (!raw)
    throw unavailable(
      "Code execution is not configured. Set JUDGE0_URL and JUDGE0_API_KEY on the server.",
    );
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    throw unavailable("JUDGE0_URL is not a valid URL.");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback))
    throw unavailable(
      "JUDGE0_URL must use HTTPS unless it runs on this machine.",
    );
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const headers: Record<string, string> = !key
    ? {}
    : base.hostname.endsWith(".rapidapi.com")
      ? { "X-RapidAPI-Key": key, "X-RapidAPI-Host": base.hostname }
      : { "X-Auth-Token": key };
  return { base, headers };
}

async function judgeRequest(
  config: Judge0Config,
  path: string,
  signal: AbortSignal,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(new URL(path, config.base), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...config.headers,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    redirect: "error",
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok || text.length > 512 * 1024)
    throw new ApiError(
      502,
      "RUNNER_ERROR",
      response.status === 429
        ? "The execution service rate limit was reached. Try again later."
        : "The execution service could not process this run.",
    );
  return JSON.parse(text) as unknown;
}

// Source code is only sent as data. Judge0 runs it in its sandbox with no
// network access (its default) and these resource limits.
function submissionBody(input: RunInput) {
  return {
    source_code: Buffer.from(input.sourceCode, "utf8").toString("base64"),
    stdin: Buffer.from(input.stdin, "utf8").toString("base64"),
    language_id: judge0LanguageIds[input.language],
    cpu_time_limit: 2,
    wall_time_limit: 5,
    memory_limit: 256000,
  };
}

const resultFields = "token,status,stdout,stderr,compile_output,exit_code,time";

// wait=true usually returns the finished result in one request; otherwise poll.
export async function executeOnJudge0(
  input: RunInput,
  signal: AbortSignal,
): Promise<{ token: string | null; result: Judge0Result }> {
  const config = judge0Configuration();
  const submitted = await judgeRequest(
    config,
    `submissions?base64_encoded=true&wait=true&fields=${resultFields}`,
    signal,
    submissionBody(input),
  );
  const token = judge0CreatedSchema.safeParse(submitted).data?.token ?? null;
  const immediate = judge0ResultSchema.safeParse(submitted);
  if (immediate.success && immediate.data.status.id > 2)
    return { token, result: immediate.data };
  if (!token)
    throw new ApiError(
      502,
      "RUNNER_ERROR",
      "The execution service returned an invalid response.",
    );
  const deadline = Date.now() + RUN_DEADLINE_MS;
  while (!signal.aborted && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    const result = judge0ResultSchema.parse(
      await judgeRequest(
        config,
        `submissions/${token}?base64_encoded=true&fields=${resultFields}`,
        signal,
      ),
    );
    if (result.status.id > 2) return { token, result };
  }
  throw new ApiError(
    504,
    "RUNNER_TIMEOUT",
    "The execution service did not finish within 30 seconds.",
  );
}

function decodeOutput(value: string | null | undefined) {
  if (value == null) return { text: null, truncated: false };
  const bytes = Buffer.from(value, "base64");
  // TextDecoder drops an incomplete UTF-8 sequence at the truncation boundary.
  const limited = bytes.subarray(0, MAX_RUN_OUTPUT_BYTES);
  const text = new TextDecoder().decode(limited, {
    stream: bytes.length > limited.length,
  });
  return { text, truncated: bytes.length > limited.length };
}

export function runFields(result: Judge0Result) {
  const stdout = decodeOutput(result.stdout);
  const stderr = decodeOutput(result.stderr);
  const compileOutput = decodeOutput(result.compile_output);
  const milliseconds =
    result.time == null ? null : Math.round(Number(result.time) * 1000);
  return {
    status:
      result.status.id === 13 ? ("FAILED" as const) : ("FINISHED" as const),
    statusLabel: result.status.description,
    judge0Status: result.status.id,
    stdout: stdout.text,
    stderr: stderr.text,
    compileOutput: compileOutput.text,
    exitCode: result.exit_code ?? null,
    durationMs:
      milliseconds !== null && Number.isSafeInteger(milliseconds)
        ? milliseconds
        : null,
    outputTruncated:
      stdout.truncated || stderr.truncated || compileOutput.truncated,
    finishedAt: new Date(),
  };
}
