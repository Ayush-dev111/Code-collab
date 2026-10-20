CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'FINISHED', 'FAILED');
ALTER TABLE "run"
  ADD COLUMN "sourceCode" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "status" "RunStatus" NOT NULL DEFAULT 'FINISHED',
  ADD COLUMN "statusLabel" TEXT NOT NULL DEFAULT 'Finished',
  ADD COLUMN "judge0Token" TEXT,
  ADD COLUMN "judge0Status" INTEGER,
  ADD COLUMN "compileOutput" TEXT,
  ADD COLUMN "outputTruncated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "finishedAt" TIMESTAMP(3);
UPDATE "run" SET "finishedAt" = "createdAt";
