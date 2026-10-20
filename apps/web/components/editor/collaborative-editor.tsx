"use client";

import { useState, type ReactElement } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import { withCollaboration } from "@blocknote/core/yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { safeLinkUrl, type RealtimeUser } from "@collab/shared";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api-client";
import { uploadPageImage } from "./upload-image";
import { useTheme } from "@/components/theme-provider";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/shadcn/style.css";

// BlockNote 0.55's default heading type violates the View's generic constraint
// with exactOptionalPropertyTypes. Keep the actual default editor and constrain
// this library boundary to the three supported props we use.
const DefaultBlockNoteView = BlockNoteView as unknown as (props: {
  editor: ReturnType<typeof useCreateBlockNote>;
  editable: boolean;
  theme: "light" | "dark";
}) => ReactElement;

export function CollaborativeEditor({
  provider,
  user,
  projectId,
  itemId,
  editable,
}: {
  provider: HocuspocusProvider;
  user: RealtimeUser;
  projectId: string;
  itemId: string;
  editable: boolean;
}) {
  const { theme } = useTheme();
  const [uploadError, setUploadError] = useState<string | null>(null);
  const editor = useCreateBlockNote(
    withCollaboration({
      collaboration: {
        fragment: provider.document.getXmlFragment("blocknote"),
        provider: provider.awareness ? { awareness: provider.awareness } : {},
        user,
        showCursorLabels: "always",
      },
      uploadFile: async (file: File) => {
        try {
          setUploadError(null);
          return await uploadPageImage(projectId, itemId, file);
        } catch (error) {
          setUploadError(errorMessage(error));
          throw error;
        }
      },
      links: {
        isValidLink: (href: string) => safeLinkUrl(href) !== undefined,
        HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
      },
      resolveFileUrl: async (url: string) => {
        try {
          const parsed = new URL(url, window.location.origin);
          if (
            parsed.origin !== window.location.origin ||
            !parsed.pathname.startsWith(
              `/api/projects/${projectId}/items/${itemId}/images/`,
            )
          )
            return "";
          return parsed.toString();
        } catch {
          return "";
        }
      },
    }),
    [provider, user.id, projectId, itemId],
  );
  return (
    <div className="collaborative-page">
      {uploadError && (
        <div
          role="alert"
          className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-destructive/20 bg-danger-soft p-3 text-sm text-destructive"
        >
          <p>{uploadError}</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setUploadError(null)}
          >
            Dismiss
          </Button>
        </div>
      )}
      <DefaultBlockNoteView editor={editor} editable={editable} theme={theme} />
    </div>
  );
}
