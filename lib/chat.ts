import { chatUserSelection, getDatabase, serializeChatMessage } from "@/lib/db";
import { ApiError } from "./api";
import { requireRole } from "./permissions";

export async function getChatHistory(
  projectId: string,
  before: string | undefined,
  requestHeaders: Headers,
) {
  await requireRole(projectId, "VIEWER", requestHeaders);
  const database = getDatabase();
  const cursor = before
    ? await database.chatMessage.findFirst({
        where: { id: before, projectId },
        select: { id: true, createdAt: true },
      })
    : null;
  if (before && !cursor)
    throw new ApiError(
      400,
      "INVALID_CURSOR",
      "Choose a message from this project's chat.",
    );
  const rows = await database.chatMessage.findMany({
    where: {
      projectId,
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 51,
    include: { user: { select: chatUserSelection } },
  });
  return {
    messages: rows.slice(0, 50).map(serializeChatMessage),
    nextCursor: rows.length > 50 ? rows[49]!.id : null,
  };
}
