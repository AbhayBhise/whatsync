-- CreateTable
CREATE TABLE "Mapping" (
    "id" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "threadTs" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedMessage" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "consentGiven" BOOLEAN NOT NULL,
    "consentAt" TIMESTAMP(3),

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Mapping_phoneNumber_key" ON "Mapping"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedMessage_messageId_key" ON "ProcessedMessage"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "Consent_phoneNumber_key" ON "Consent"("phoneNumber");
