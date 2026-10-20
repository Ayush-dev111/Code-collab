import { getDatabase } from "../dist/index.js";

const database = getDatabase();

try {
  // Each count verifies that the migrated table is accessible to Prisma.
  const tables = await Promise.all([
    database.user.count().then((rows) => ({ table: "User", rows })),
    database.session.count().then((rows) => ({ table: "Session", rows })),
    database.account.count().then((rows) => ({ table: "Account", rows })),
    database.verification
      .count()
      .then((rows) => ({ table: "Verification", rows })),
    database.project.count().then((rows) => ({ table: "Project", rows })),
    database.projectMember
      .count()
      .then((rows) => ({ table: "ProjectMember", rows })),
    database.item.count().then((rows) => ({ table: "Item", rows })),
    database.chatMessage
      .count()
      .then((rows) => ({ table: "ChatMessage", rows })),
    database.run.count().then((rows) => ({ table: "Run", rows })),
    database.invite.count().then((rows) => ({ table: "Invite", rows })),
  ]);
  console.table(tables);
  console.info("All 10 application tables are available.");
} catch {
  console.error(
    "Database verification failed. Check DATABASE_URL, start PostgreSQL, and apply the migration.",
  );
  process.exitCode = 1;
} finally {
  await database.$disconnect();
}
