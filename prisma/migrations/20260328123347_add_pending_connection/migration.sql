-- CreateTable
CREATE TABLE "PendingConnection" (
    "id" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingConnection_pkey" PRIMARY KEY ("id")
);
