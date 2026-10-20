import { createServer, type Socket } from "node:net";
import assert from "node:assert/strict";

// RESP2 protocol fixture only. It models expected responses and never executes
// Lua. CI and test:phase8 use real Redis to verify the scripts themselves.
export async function createRedisFixture(ignoreFixedWindowLimits = false) {
  const connections = new Set<Socket>();
  const counters = new Map<
    string,
    { value: number | string; expires: number }
  >();
  let unavailable = false;
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      if (unavailable) {
        socket.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        const parsed = parseCommand(buffer);
        if (!parsed) return;
        buffer = buffer.subarray(parsed.length);
        for (const [key, entry] of counters)
          if (entry.expires <= Date.now()) counters.delete(key);
        const [command, ...args] = parsed.args;
        if (command === "GET") {
          const entry = counters.get(args[0]!);
          const value = entry ? String(entry.value) : null;
          socket.write(
            value === null
              ? "$-1\r\n"
              : `$${Buffer.byteLength(value)}\r\n${value}\r\n`,
          );
        } else if (command === "PTTL")
          socket.write(
            `:${counters.has(args[0]!) ? counters.get(args[0]!)!.expires - Date.now() : -2}\r\n`,
          );
        else if (command === "DEL") {
          let count = 0;
          for (const key of args) if (counters.delete(key)) count += 1;
          socket.write(`:${count}\r\n`);
        } else if (command === "PING") socket.write("+PONG\r\n");
        else if (command === "EVAL") {
          const [script, keyCount, ...values] = args;
          const count = Number(keyCount);
          const keys = values.slice(0, count);
          const argv = values.slice(count);
          if (script?.includes("collab-fixed-window-v1")) {
            if (ignoreFixedWindowLimits) {
              socket.write("*2\r\n:0\r\n:0\r\n");
              continue;
            }
            const blocked = keys.find(
              (key, index) =>
                Number(counters.get(key)?.value ?? 0) >=
                Number(argv[index + 1]),
            );
            if (blocked)
              socket.write(
                `*2\r\n:1\r\n:${Math.max(1, counters.get(blocked)!.expires - Date.now())}\r\n`,
              );
            else {
              for (const key of keys)
                counters.set(key, {
                  value: Number(counters.get(key)?.value ?? 0) + 1,
                  expires:
                    counters.get(key)?.expires ?? Date.now() + Number(argv[0]),
                });
              socket.write("*2\r\n:0\r\n:0\r\n");
            }
          } else if (script?.includes("INCR")) {
            const blocked =
              Number(counters.get(keys[0]!)?.value ?? 0) >= 6
                ? keys[0]
                : Number(counters.get(keys[1]!)?.value ?? 0) >= 20
                  ? keys[1]
                  : undefined;
            if (blocked)
              socket.write(
                `*2\r\n:1\r\n:${Math.max(1, counters.get(blocked)!.expires - Date.now())}\r\n`,
              );
            else if (counters.has(keys[2]!))
              socket.write(
                `*2\r\n:2\r\n:${Math.max(1, counters.get(keys[2]!)!.expires - Date.now())}\r\n`,
              );
            else {
              for (const key of keys.slice(0, 2))
                counters.set(key, {
                  value: Number(counters.get(key)?.value ?? 0) + 1,
                  expires: counters.get(key)?.expires ?? Date.now() + 60000,
                });
              counters.set(keys[2]!, {
                value: argv[0]!,
                expires: Date.now() + Number(argv[1]),
              });
              socket.write("*2\r\n:0\r\n:0\r\n");
            }
          } else {
            const matches = counters.get(keys[0]!)?.value === argv[0];
            if (matches) counters.delete(keys[0]!);
            socket.write(`:${matches ? 1 : 0}\r\n`);
          }
        } else socket.write("+OK\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `redis://127.0.0.1:${address.port}`,
    setUnavailable(value: boolean) {
      unavailable = value;
      if (value) for (const socket of connections) socket.destroy();
    },
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
function parseCommand(
  buffer: Buffer,
): { args: string[]; length: number } | null {
  const firstEnd = buffer.indexOf("\r\n");
  if (firstEnd < 0) return null;
  assert.equal(buffer[0], 42);
  const count = Number(buffer.toString("ascii", 1, firstEnd));
  const args: string[] = [];
  let offset = firstEnd + 2;
  for (let index = 0; index < count; index += 1) {
    const end = buffer.indexOf("\r\n", offset);
    if (end < 0) return null;
    assert.equal(buffer[offset], 36);
    const length = Number(buffer.toString("ascii", offset + 1, end));
    if (buffer.length < end + 2 + length + 2) return null;
    args.push(buffer.toString("utf8", end + 2, end + 2 + length));
    offset = end + 2 + length + 2;
  }
  return { args, length: offset };
}
