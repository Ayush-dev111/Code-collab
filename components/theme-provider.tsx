"use client";

import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export type ThemePreference = "light" | "dark" | "system";
const key = "collab:theme";
const event = "collab-theme-change";
let transientPreference: ThemePreference | null = null;

function applyTheme() {
  let preference: ThemePreference = "system";
  try {
    const saved = localStorage.getItem(key);
    if (saved === "light" || saved === "dark") preference = saved;
  } catch {
    /* System preference also works without browser storage. */
  }
  if (transientPreference) preference = transientPreference;
  const theme =
    preference === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preference;
}

function subscribe(callback: () => void) {
  const media = matchMedia("(prefers-color-scheme: dark)");
  const update = () => {
    applyTheme();
    callback();
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === key || e.key === null) {
      transientPreference = null;
      update();
    }
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(event, callback);
  media.addEventListener("change", update);
  update();
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(event, callback);
    media.removeEventListener("change", update);
  };
}

function snapshot() {
  return `${document.documentElement.dataset.themePreference ?? "system"}:${document.documentElement.dataset.theme ?? "light"}`;
}

const ThemeContext = createContext({
  theme: "light" as "light" | "dark",
  preference: "system" as ThemePreference,
  setPreference: (_preference: ThemePreference) => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const value = useSyncExternalStore(subscribe, snapshot, () => "system:light");
  const [preference, theme] = value.split(":") as [
    ThemePreference,
    "light" | "dark",
  ];
  function setPreference(next: ThemePreference) {
    try {
      localStorage.setItem(key, next);
      transientPreference = null;
    } catch {
      transientPreference = next;
      /* The current tab still changes theme. */
    }
    document.documentElement.dataset.themePreference = next;
    document.documentElement.dataset.theme =
      next === "system"
        ? matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : next;
    window.dispatchEvent(new Event(event));
  }
  return (
    <ThemeContext.Provider value={{ theme, preference, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
