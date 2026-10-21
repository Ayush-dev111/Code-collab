import { PrismaPg } from "@prisma/adapter-pg";
import { chatMessageSchema, userColor } from "@/lib/shared";
import { PrismaClient } from "@/lib/generated/prisma/client";

// One client per process. It lives on globalThis because the realtime server
// and Next.js route handlers load this module separately.
const databaseGlobal = globalThis as typeof globalThis & {
  collabDatabase?: PrismaClient;
};

export function getDatabase(): PrismaClient {
  if (databaseGlobal.collabDatabase) return databaseGlobal.collabDatabase;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const adapter = new PrismaPg({
    connectionString: url,
    max: 10,
    keepAlive: true,
    idleTimeoutMillis: 30000,
  });
  databaseGlobal.collabDatabase = new PrismaClient({ adapter });
  return databaseGlobal.collabDatabase;
}

export const chatUserSelection = { id: true, name: true } as const;
export function serializeChatMessage(row: {
  id: string;
  projectId: string;
  body: string;
  createdAt: Date;
  user: { id: string; name: string };
}) {
  return chatMessageSchema.parse({
    id: row.id,
    projectId: row.projectId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    user: {
      id: row.user.id,
      name: row.user.name.trim().slice(0, 80) || "Collaborator",
      color: userColor(row.user.id),
    },
  });
}
