import { PrismaPg } from "@prisma/adapter-pg";
import { databaseEnvironmentSchema } from "@collab/shared";
import { PrismaClient } from "./generated/prisma/client.js";

// Lazy initialization keeps builds independent of a running database.
const databaseGlobal = globalThis as typeof globalThis & {
  collabDatabase?: PrismaClient;
};

export function getDatabase(): PrismaClient {
  if (databaseGlobal.collabDatabase) return databaseGlobal.collabDatabase;

  const environment = databaseEnvironmentSchema.parse(process.env);
  const adapter = new PrismaPg({
    connectionString: environment.DATABASE_URL,
    max: 10,
    keepAlive: true,
    idleTimeoutMillis: 30000,
  });
  const database = new PrismaClient({ adapter });
  databaseGlobal.collabDatabase = database;
  return database;
}

export { PrismaClient } from "./generated/prisma/client.js";
export { chatUserSelection, serializeChatMessage } from "./chat.js";
