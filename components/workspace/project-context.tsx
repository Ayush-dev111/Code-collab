"use client";

import { createContext, useContext } from "react";
import type { HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import type { ProjectDetails, RealtimeUser } from "@/lib/shared";

type ProjectContextValue = {
  project: ProjectDetails;
  user: RealtimeUser;
  // The WebSocket shared by every document in this project.
  documentSocket: () => HocuspocusProviderWebsocket;
};

const ProjectContext = createContext<ProjectContextValue | null>(null);
export const ProjectProvider = ProjectContext.Provider;

// Only stable values live here, so editors do not re-render on presence or
// typing updates.
export function useProject() {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("useProject must be used inside a project.");
  return value;
}
