"use client";

import { useEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { MonacoBinding } from "y-monaco";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import {
  awarenessStateSchema,
  type CodeLanguage,
  type RealtimeUser,
} from "@collab/shared";
import type { CodeTheme } from "./editor-settings";
import "./monaco-runtime";

export function MonacoDocument({
  provider,
  user,
  language,
  editable,
  theme,
  fontSize,
}: {
  provider: HocuspocusProvider;
  user: RealtimeUser;
  language: CodeLanguage;
  editable: boolean;
  theme: CodeTheme;
  fontSize: number;
}) {
  const cleanupRef = useRef<(() => void) | undefined>(undefined);
  const scope = `code-monaco-${provider.document.clientID}`;
  useEffect(() => () => cleanupRef.current?.(), []);
  const onMount: OnMount = (editor) => {
    cleanupRef.current?.();
    const model = editor.getModel();
    if (!model) return;
    const awareness = provider.awareness;
    awareness?.setLocalStateField("user", user);
    const binding = new MonacoBinding(
      provider.document.getText("code"),
      model,
      new Set([editor]),
      awareness,
    );
    const style = document.createElement("style");
    document.head.append(style);
    function updateCursors() {
      const rules: string[] = [];
      for (const [clientId, value] of awareness?.getStates() ?? []) {
        const state = awarenessStateSchema.safeParse(value);
        if (!state.success || !Number.isSafeInteger(clientId) || clientId < 0)
          continue;
        const { color, name } = state.data.user;
        rules.push(`.${scope} .yRemoteSelection-${clientId} { background: ${color}33; }
          .${scope} .yRemoteSelectionHead-${clientId} { border-left: 2px solid ${color}; position: relative; }
          .${scope} .yRemoteSelectionHead-${clientId}::after { content: ${JSON.stringify(name)}; position: absolute; top: -1.35em; left: -2px; padding: 1px 4px; border-radius: 3px; background: ${color}; color: white; font: 11px/16px Arial, sans-serif; white-space: nowrap; z-index: 10; pointer-events: none; }`);
      }
      style.textContent = rules.join("\n");
    }
    awareness?.on("change", updateCursors);
    updateCursors();
    cleanupRef.current = () => {
      awareness?.off("change", updateCursors);
      style.remove();
      binding.destroy();
      cleanupRef.current = undefined;
    };
  };
  return (
    <div
      className={`${scope} overflow-hidden rounded-xl border`}
      aria-label="Shared code editor"
    >
      <Editor
        height="440px"
        language={language}
        theme={theme}
        onMount={onMount}
        loading={
          <p role="status" className="p-6 text-sm text-muted-foreground">
            Loading Monaco...
          </p>
        }
        options={{
          readOnly: !editable,
          domReadOnly: !editable,
          fontSize,
          fontFamily: "'Cascadia Code', 'SFMono-Regular', Consolas, monospace",
          minimap: { enabled: false },
          automaticLayout: true,
          scrollBeyondLastLine: false,
          wordWrap: "on",
          padding: { top: 24, bottom: 16 },
          ariaLabel: "Collaborative code",
          editContext: false,
          tabSize: 2,
        }}
      />
    </div>
  );
}
