-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "phoneHash" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "initiatedBy" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
