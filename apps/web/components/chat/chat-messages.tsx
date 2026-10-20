import type { ChatMessage } from "@collab/shared";

export function ChatMessages({ messages }: { messages: ChatMessage[] }) {
  return (
    <ol aria-label="Chat messages" className="space-y-2 px-4 py-4">
      {messages.map((message, index) => {
        const previous = messages[index - 1];
        const time = new Date(message.createdAt);
        const grouped =
          previous?.user.id === message.user.id &&
          Date.parse(message.createdAt) - Date.parse(previous.createdAt) <=
            300000 &&
          new Date(previous.createdAt).toDateString() === time.toDateString();
        return (
          <li
            key={message.id}
            data-chat-message={message.id}
            className={grouped ? "pl-8" : "pt-3"}
          >
            {!grouped && (
              <div className="mb-1 flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                  style={{ backgroundColor: message.user.color }}
                >
                  {message.user.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 truncate text-xs font-semibold">
                  {message.user.name}
                </span>
                <time
                  dateTime={message.createdAt}
                  title={time.toLocaleString()}
                  className="ml-auto shrink-0 text-[10px] text-muted-foreground"
                >
                  {time.toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}{" "}
                  {time.toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
            )}
            <p
              className={`${grouped ? "" : "pl-8 "}whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere]`}
              title={
                grouped
                  ? `${message.user.name} · ${time.toLocaleString()}`
                  : undefined
              }
            >
              {message.body}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
