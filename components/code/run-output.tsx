"use client";

import type { CodeRun } from "@/lib/shared";

export function RunOutput({ run }: { run: CodeRun | undefined }) {
  if (!run)
    return (
      <p className="py-6 text-sm text-muted-foreground">
        Run this file to share its output with the project.
      </p>
    );
  const failed =
    run.status === "FAILED" ||
    (run.judge0Status !== null && run.judge0Status !== 3);
  return (
    <div aria-label="Run output" className="space-y-4">
      <div
        role="status"
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
      >
        <span
          className={failed ? "font-medium text-destructive" : "font-medium"}
        >
          {run.statusLabel}
        </span>
        <span>By {run.userName}</span>
        <span>{run.language}</span>
        {run.exitCode !== null && <span>Exit code: {run.exitCode}</span>}
        {run.durationMs !== null && <span>Runtime: {run.durationMs} ms</span>}
      </div>
      {run.status === "RUNNING" ? (
        <p className="text-sm text-muted-foreground">
          Running code in the sandbox...
        </p>
      ) : (
        <>
          <div>
            <h4 className="mb-2 text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-success inline-block" />
              Standard output
            </h4>
            <pre
              aria-label="Standard output"
              className="max-h-64 overflow-auto rounded-md border border-border bg-[#0d1117] p-3.5 font-mono text-xs whitespace-pre-wrap break-words text-[#e6edf3] shadow-inner"
            >
              {run.stdout || "No standard output."}
            </pre>
          </div>
          {(run.stderr || failed) && (
            <div>
              <h4 className="mb-2 text-xs font-semibold text-destructive flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-destructive inline-block" />
                Standard error
              </h4>
              <pre
                aria-label="Standard error"
                className="max-h-64 overflow-auto rounded-md border border-destructive/30 bg-danger-soft/40 p-3.5 font-mono text-xs whitespace-pre-wrap break-words text-destructive"
              >
                {run.stderr || run.statusLabel}
              </pre>
            </div>
          )}
          {run.compileOutput && (
            <div>
              <h4 className="mb-2 text-xs font-medium text-destructive">
                Compiler output
              </h4>
              <pre
                aria-label="Compiler output"
                className="max-h-64 overflow-auto rounded-lg bg-danger-soft p-4 font-mono text-xs whitespace-pre-wrap break-words text-destructive"
              >
                {run.compileOutput}
              </pre>
            </div>
          )}
          {run.outputTruncated && (
            <p className="text-xs text-warning">
              Output was shortened to 16 KiB per stream.
            </p>
          )}
        </>
      )}
    </div>
  );
}
