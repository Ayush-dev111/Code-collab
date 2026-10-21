-- CreateTable
CREATE TABLE "image" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "image_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "image_itemId_idx" ON "image"("itemId");

-- AddForeignKey
ALTER TABLE "image" ADD CONSTRAINT "image_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
