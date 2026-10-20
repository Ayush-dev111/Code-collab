import {
  judge0CreatedSchema,
  judge0LanguagesSchema,
  judge0LanguageIds,
  judge0ResultSchema,
  MAX_RUN_OUTPUT_BYTES,
  RUN_DEADLINE_MS,
  runnerEnvironmentSchema,
  type Judge0Result,
  type RunInput,
  type RunnerEnvironment,
} from "@collab/shared";
import { ApiError } from "./api";

let cachedRunnerConfig: { value: RunnerEnvironment | null } | undefined;

export function tryRunnerConfiguration(): RunnerEnvironment | null {
  if (!cachedRunnerConfig) {
    const parsed = runnerEnvironmentSchema.safeParse(process.env);
    cachedRunnerConfig = { value: parsed.success ? parsed.data : null };
  }
  return cachedRunnerConfig.value;
}

export function runnerConfiguration(): RunnerEnvironment {
  const config = tryRunnerConfiguration();
  if (!config)
    throw new ApiError(
      503,
      "RUNNER_UNAVAILABLE",
      "Code execution is unavailable. Configure Judge0 and Redis on the server.",
    );
  return config;
}

// No callback, additional files, compiler flags or network controls come from
// the client. Source code is only sent as data to the private sandbox service.
export function submissionBody(input: RunInput) {
  return {
    source_code: Buffer.from(input.sourceCode, "utf8").toString("base64"),
    stdin: Buffer.from(input.stdin, "utf8").toString("base64"),
    language_id: judge0LanguageIds[input.language],
    cpu_time_limit: 2,
    cpu_extra_time: 0.5,
    wall_time_limit: 5,
    memory_limit: 256000,
    stack_limit: 64000,
    max_processes_and_or_threads: 60,
    max_file_size: 64,
    enable_network: false,
    enable_per_process_and_thread_time_limit: false,
    enable_per_process_and_thread_memory_limit: false,
    redirect_stderr_to_stdout: false,
    number_of_runs: 1,
  };
}

async function judgeRequest(
  configuration: RunnerEnvironment,
  path: string,
  signal: AbortSignal,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(new URL(path, configuration.JUDGE0_URL), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Auth-Token": configuration.JUDGE0_AUTH_TOKEN,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new ApiError(
      502,
      "RUNNER_ERROR",
      "The execution service could not process this run.",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 512 * 1024) {
        await reader.cancel();
        throw new ApiError(
          502,
          "RUNNER_ERROR",
          "The execution service returned too much data.",
        );
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    reader.releaseLock();
  }
}

let languageCache: {
  data: ReturnType<typeof judge0LanguagesSchema.parse>;
  cachedAt: number;
} | null = null;
const LANGUAGE_CACHE_TTL_MS = 5 * 60 * 1000;

export async function submitCode(
  configuration: RunnerEnvironment,
  input: RunInput,
  signal: AbortSignal,
): Promise<string> {
  const now = Date.now();
  if (!languageCache || now - languageCache.cachedAt > LANGUAGE_CACHE_TTL_MS) {
    languageCache = {
      data: judge0LanguagesSchema.parse(
        await judgeRequest(configuration, "/languages", signal),
      ),
      cachedAt: now,
    };
  }
  const languages = languageCache.data;
  const selected = languages.find(
    (entry) => entry.id === judge0LanguageIds[input.language],
  );
  const expected = {
    python: "Python (3.",
    javascript: "JavaScript (",
    cpp: "C++ (",
    java: "Java (",
  };
  if (!selected?.name.startsWith(expected[input.language]))
    throw new ApiError(
      503,
      "LANGUAGE_UNAVAILABLE",
      "This Judge0 installation does not provide the selected runtime.",
    );
  const created = judge0CreatedSchema.parse(
    await judgeRequest(
      configuration,
      "/submissions?base64_encoded=true&wait=false",
      signal,
      submissionBody(input),
    ),
  );
  return created.token;
}

export async function readSubmission(
  configuration: RunnerEnvironment,
  token: string,
  signal: AbortSignal,
): Promise<Judge0Result> {
  const validated = judge0CreatedSchema.parse({ token });
  return judge0ResultSchema.parse(
    await judgeRequest(
      configuration,
      `/submissions/${validated.token}?base64_encoded=true&fields=status,stdout,stderr,compile_output,exit_code,time`,
      signal,
    ),
  );
}

export async function waitForSubmission(
  configuration: RunnerEnvironment,
  token: string,
  signal: AbortSignal,
): Promise<Judge0Result> {
  const deadline = Date.now() + RUN_DEADLINE_MS;
  while (!signal.aborted && Date.now() < deadline) {
    const result = await readSubmission(configuration, token, signal);
    if (result.status.id > 2) return result;
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  throw new ApiError(
    504,
    "RUNNER_TIMEOUT",
    "The execution service did not finish within 30 seconds.",
  );
}

function decodeOutput(value: string | null | undefined) {
  if (value == null) return { text: null, truncated: false };
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new ApiError(
      502,
      "RUNNER_ERROR",
      "The execution service returned invalid output.",
    );
  const bytes = Buffer.from(value, "base64");
  // TextDecoder drops an incomplete UTF-8 sequence at the truncation boundary.
  const limited = bytes.subarray(0, MAX_RUN_OUTPUT_BYTES);
  const text = new TextDecoder().decode(limited, {
    stream: bytes.length > limited.length,
  });
  return { text, truncated: bytes.length > limited.length };
}

export function resultFields(result: Judge0Result) {
  const stdout = decodeOutput(result.stdout);
  const stderr = decodeOutput(result.stderr);
  const compileOutput = decodeOutput(result.compile_output);
  const milliseconds =
    result.time == null ? null : Math.round(Number(result.time) * 1000);
  if (
    milliseconds !== null &&
    (!Number.isSafeInteger(milliseconds) ||
      milliseconds < 0 ||
      milliseconds > 2_147_483_647)
  )
    throw new ApiError(
      502,
      "RUNNER_ERROR",
      "The execution service returned an invalid runtime.",
    );
  return {
    status:
      result.status.id === 13 ? ("FAILED" as const) : ("FINISHED" as const),
    statusLabel: result.status.description,
    judge0Status: result.status.id,
    stdout: stdout.text,
    stderr: stderr.text,
    compileOutput: compileOutput.text,
    exitCode: result.exit_code ?? null,
    durationMs: milliseconds,
    outputTruncated:
      stdout.truncated || stderr.truncated || compileOutput.truncated,
    finishedAt: new Date(),
  };
}
