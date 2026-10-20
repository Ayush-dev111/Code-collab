ALTER TABLE "chat_message" ADD COLUMN "clientMessageId" TEXT;
CREATE UNIQUE INDEX "chat_message_userId_clientMessageId_key" ON "chat_message"("userId", "clientMessageId");
