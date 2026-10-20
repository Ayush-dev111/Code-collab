"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

type ConnectionState = {
  online: boolean | null;
  setOnline: (online: boolean) => void;
};

const ConnectionContext = createContext<ReturnType<
  typeof createConnectionStore
> | null>(null);

function createConnectionStore() {
  return createStore<ConnectionState>()((set) => ({
    online: null,
    setOnline: (online) => set({ online }),
  }));
}

function OfflineNotice() {
  const store = useContext(ConnectionContext);
  if (!store) throw new Error("Connection store is unavailable");
  const online = useStore(store, (state) => state.online);

  if (online !== false) return null;
  return (
    <div
      role="status"
      className="border-b border-warning/20 bg-warning-soft px-6 py-3 text-center text-sm text-warning"
    >
      You’re offline. Keep this tab open; your document edits will sync when you
      reconnect.
    </div>
  );
}

export function ConnectionBanner() {
  const [store] = useState(createConnectionStore);

  useEffect(() => {
    const update = () => store.getState().setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [store]);

  return (
    <ConnectionContext.Provider value={store}>
      <OfflineNotice />
    </ConnectionContext.Provider>
  );
}
