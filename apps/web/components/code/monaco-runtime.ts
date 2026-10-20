import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";

// These static module URLs let Next bundle all workers on our own origin.
const workerEnvironment: monaco.Environment = {
  getWorker(_moduleId, label) {
    if (label === "typescript" || label === "javascript")
      return new Worker(
        new URL(
          "monaco-editor/languages/features/typescript/ts.worker.js",
          import.meta.url,
        ),
        { type: "module" },
      );
    if (label === "json")
      return new Worker(
        new URL(
          "monaco-editor/languages/features/json/json.worker.js",
          import.meta.url,
        ),
        { type: "module" },
      );
    if (label === "css" || label === "scss" || label === "less")
      return new Worker(
        new URL(
          "monaco-editor/languages/features/css/css.worker.js",
          import.meta.url,
        ),
        { type: "module" },
      );
    if (label === "html" || label === "handlebars" || label === "razor")
      return new Worker(
        new URL(
          "monaco-editor/languages/features/html/html.worker.js",
          import.meta.url,
        ),
        { type: "module" },
      );
    return new Worker(
      new URL("monaco-editor/editor/editor.worker.js", import.meta.url),
      { type: "module" },
    );
  },
};
Object.assign(globalThis, { MonacoEnvironment: workerEnvironment });
loader.config({ monaco });
export { monaco };
