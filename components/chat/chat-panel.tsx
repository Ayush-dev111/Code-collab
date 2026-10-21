"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import {
  chatHistoryResponseSchema,
  chatSendSchema,
  hasMinimumRole,
  type ChatMessage,
  type Role,
} from "@/lib/shared";
import { apiRequest, errorMessage, useOnline } from "@/lib/api-client";
import type { ProjectRealtime } from "@/lib/realtime-client";
import { Button } from "@/components/ui/button";
import { ChatMessages } from "./chat-messages";
import { Icon } from "@/components/ui/icon";

function subscribeVisibility(callback: () => void) {
  document.addEventListener("visibilitychange", callback);
  return () => document.removeEventListener("visibilitychange", callback);
}
function compareMessages(
  a: Pick<ChatMessage, "createdAt" | "id">,
  b: Pick<ChatMessage, "createdAt" | "id">,
) {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

export function ChatPanel({
  projectId,
  role,
  userId,
  realtime,
  active = true,
}: {
  projectId: string;
  role: Role;
  userId: string | undefined;
  realtime: ProjectRealtime;
  active?: boolean;
}) {
  const online = useOnline();
  const visible = useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === "visible",
    () => true,
  );
  const [expanded, setExpanded] = useState(true);
  const [body, setBody] = useState("");
  const [live, setLive] = useState<ChatMessage[]>([]);
  const [lastRead, setLastRead] = useState<Pick<
    ChatMessage,
    "createdAt" | "id"
  > | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  const pending = useRef<{ body: string; clientMessageId: string } | null>(
    null,
  );
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const lastTyping = useRef(0);
  const previousHeight = useRef<{ height: number; top: number } | null>(null);
  const editable = hasMinimumRole(role, "EDITOR");
  const ready = online && realtime.connected;
  const { subscribeChat, sendTyping } = realtime;
  const history = useInfiniteQuery({
    queryKey: ["chat", projectId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      apiRequest(
        `/api/projects/${projectId}/chat${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ""}`,
        chatHistoryResponseSchema,
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: ready ? false : 30000,
    retry: false,
  });
  useEffect(
    () =>
      subscribeChat((message) =>
        setLive((previous) =>
          [
            ...previous.filter((entry) => entry.id !== message.id),
            message,
          ].slice(-100),
        ),
      ),
    [subscribeChat],
  );
  useEffect(
    () => () => {
      clearTimeout(typingTimer.current);
      sendTyping(false);
    },
    [sendTyping],
  );
  const byId = new Map<string, ChatMessage>();
  for (const message of history.data?.pages.flatMap((page) => page.messages) ??
    [])
    byId.set(message.id, message);
  for (const message of live) byId.set(message.id, message);
  const messages = [...byId.values()].sort(compareMessages);
  const newest = messages.at(-1) ?? null;
  const unread = lastRead
    ? messages.filter(
        (message) =>
          message.user.id !== userId && compareMessages(message, lastRead) > 0,
      ).length
    : 0;
  if (!lastRead && history.isSuccess)
    setLastRead(newest ?? { createdAt: "1970-01-01T00:00:00.000Z", id: "" });
  else if (
    newest &&
    lastRead &&
    expanded &&
    active &&
    visible &&
    atBottom &&
    compareMessages(newest, lastRead) > 0
  )
    setLastRead(newest);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    if (previousHeight.current) {
      element.scrollTop =
        previousHeight.current.top +
        element.scrollHeight -
        previousHeight.current.height;
      previousHeight.current = null;
    } else if (atBottom && expanded && active)
      element.scrollTop = element.scrollHeight;
  }, [newest?.id, messages.length, atBottom, expanded, active]);
  const mutation = useMutation({
    mutationFn: async () => {
      const text = body.trim();
      if (pending.current?.body !== text)
        pending.current = { body: text, clientMessageId: crypto.randomUUID() };
      return realtime.sendChat(
        chatSendSchema.parse({ projectId, ...pending.current }),
      );
    },
    onSuccess: (message) => {
      setLive((previous) =>
        [...previous.filter((entry) => entry.id !== message.id), message].slice(
          -100,
        ),
      );
      pending.current = null;
      setBody("");
      setAtBottom(true);
      realtime.sendTyping(false);
      clearTimeout(typingTimer.current);
    },
  });
  function updateBody(value: string) {
    setBody(value);
    mutation.reset();
    clearTimeout(typingTimer.current);
    if (!value.trim()) realtime.sendTyping(false);
    else {
      if (Date.now() - lastTyping.current > 1000) {
        realtime.sendTyping(true);
        lastTyping.current = Date.now();
      }
      typingTimer.current = setTimeout(() => realtime.sendTyping(false), 2000);
    }
  }
  const typingNames = realtime.typingUsers
    .filter((user) => user.id !== userId)
    .map((user) => user.name);
  return (
    <aside
      aria-labelledby="chat-title"
      className="flex h-full min-w-0 flex-col overflow-hidden rounded-md border border-border bg-card shadow-xs"
    >
      <div className="flex h-11 items-center justify-between gap-2 border-b border-border bg-secondary/50 px-3.5 py-2">
        <div className="flex items-center gap-2">
          <Icon name="chat" className="size-3.5 text-muted-foreground" />
          <h2 id="chat-title" className="text-xs font-semibold">
            Team chat
          </h2>
          {unread > 0 && (
            <span
              aria-label={`${unread} unread messages`}
              className="ml-1 rounded-full border border-border bg-secondary px-2 py-0.2 text-[10px] font-mono text-foreground"
            >
              {unread}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          aria-controls="chat-content"
          aria-label={expanded ? "Collapse chat" : "Expand chat"}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Hide" : "Show"}
        </Button>
      </div>
      {expanded && (
        <div id="chat-content" className="flex min-h-80 flex-1 flex-col">
          <div
            ref={viewport}
            aria-label="Chat history"
            className="max-h-[65dvh] min-h-64 flex-1 overflow-y-auto overscroll-contain"
            onScroll={(event) => {
              const element = event.currentTarget;
              setAtBottom(
                element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight <
                  32,
              );
            }}
          >
            {history.hasNextPage && (
              <div className="px-4 pt-3">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!online || history.isFetching}
                  onClick={() => {
                    const element = viewport.current;
                    if (element)
                      previousHeight.current = {
                        height: element.scrollHeight,
                        top: element.scrollTop,
                      };
                    void history.fetchNextPage();
                  }}
                >
                  {" "}
                  {history.isFetchingNextPage
                    ? "Loading…"
                    : "Load older messages"}
                </Button>
              </div>
            )}
            {history.isPending && (
              <p role="status" className="p-5 text-xs text-muted-foreground">
                Loading messages…
              </p>
            )}
            {history.isError && (
              <div className="p-4 text-xs">
                <p role="alert">{errorMessage(history.error)}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  disabled={!online || history.isFetching}
                  onClick={() => void history.refetch()}
                >
                  Retry history
                </Button>
              </div>
            )}
            {!history.isPending &&
              !history.isError &&
              messages.length === 0 && (
                <div className="px-5 py-12 text-center">
                  <span className="mx-auto flex size-11 items-center justify-center rounded-xl bg-blue-soft text-blue">
                    <Icon name="chat" className="size-5" />
                  </span>
                  <h3 className="mt-4 text-sm font-semibold">
                    Great work starts with a hello.
                  </h3>
                  <p className="mt-2 text-xs leading-6 text-muted-foreground">
                    Share an idea, ask a question, or keep your team in the
                    loop.
                  </p>
                </div>
              )}
            <ChatMessages messages={messages} />
          </div>
          {unread > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="mx-4 mb-2"
              onClick={() => {
                setAtBottom(true);
                setLastRead(newest);
              }}
            >
              Jump to latest · {unread} unread
            </Button>
          )}
          <p
            role="status"
            aria-label="Chat typing status"
            className="min-h-6 px-4 text-xs text-muted-foreground"
          >
            {typingNames.length
              ? `${typingNames.slice(0, 2).join(", ")}${typingNames.length > 2 ? " and others" : ""} ${typingNames.length === 1 ? "is" : "are"} typing…`
              : ""}
          </p>
          {!ready && (
            <div className="border-t bg-warning-soft px-4 py-3 text-xs text-warning">
              <p>
                {online
                  ? "Chat is reconnecting. Your draft stays here."
                  : "You're offline. Your draft stays here."}
              </p>
              {online && realtime.error && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={realtime.reconnect}
                >
                  Reconnect chat
                </Button>
              )}
            </div>
          )}
          {editable ? (
            <form
              className="mt-auto border-t p-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (ready && !mutation.isPending && body.trim())
                  mutation.mutate();
              }}
            >
              <label htmlFor="chat-message" className="sr-only">
                Message your team
              </label>
              <textarea
                id="chat-message"
                rows={3}
                maxLength={2000}
                value={body}
                disabled={mutation.isPending}
                placeholder="Write a message…"
                className="w-full resize-none rounded-md border border-border bg-card px-3 py-2 text-xs placeholder:text-muted-foreground transition-all shadow-xs focus-visible:border-blue focus-visible:ring-1 focus-visible:ring-blue/30 focus-visible:outline-none disabled:opacity-60"
                onChange={(event) => updateBody(event.target.value)}
                onBlur={() => realtime.sendTyping(false)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              {mutation.isError && (
                <p role="alert" className="mt-2 text-xs text-destructive">
                  {errorMessage(mutation.error)}
                </p>
              )}
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted-foreground">
                  Shift + Enter for a new line
                </span>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!ready || mutation.isPending || !body.trim()}
                >
                  {mutation.isPending
                    ? "Sending…"
                    : mutation.isError
                      ? "Retry send"
                      : "Send"}
                  <Icon name="send" className="size-3.5" />
                </Button>
              </div>
            </form>
          ) : (
            <p className="border-t p-4 text-xs text-muted-foreground">
              You have read-only chat access.
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
