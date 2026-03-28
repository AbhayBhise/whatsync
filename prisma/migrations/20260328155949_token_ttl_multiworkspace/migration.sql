/*
  Warnings:

  - The primary key for the `Consent` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `consentAt` on the `Consent` table. All the data in the column will be lost.
  - You are about to drop the column `id` on the `Consent` table. All the data in the column will be lost.
  - You are about to drop the column `createdAt` on the `Mapping` table. All the data in the column will be lost.
  - The primary key for the `ProcessedMessage` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `id` on the `ProcessedMessage` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[phoneNumber,teamId]` on the table `Mapping` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[token]` on the table `PendingConnection` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `teamId` to the `Consent` table without a default value. This is not possible if the table is not empty.
  - Added the required column `teamId` to the `Mapping` table without a default value. This is not possible if the table is not empty.
  - Added the required column `expiresAt` to the `PendingConnection` table without a default value. This is not possible if the table is not empty.
  - Added the required column `teamId` to the `PendingConnection` table without a default value. This is not possible if the table is not empty.
  - Added the required column `token` to the `PendingConnection` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "Consent_phoneNumber_key";

-- DropIndex
DROP INDEX "Mapping_phoneNumber_key";

-- DropIndex
DROP INDEX "ProcessedMessage_messageId_key";

-- AlterTable
ALTER TABLE "Consent" DROP CONSTRAINT "Consent_pkey",
DROP COLUMN "consentAt",
DROP COLUMN "id",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "teamId" TEXT NOT NULL DEFAULT 'default_workspace',
ADD CONSTRAINT "Consent_pkey" PRIMARY KEY ("phoneNumber");

-- AlterTable
ALTER TABLE "Mapping" DROP COLUMN "createdAt",
ADD COLUMN     "teamId" TEXT NOT NULL DEFAULT 'default_workspace';

-- AlterTable
ALTER TABLE "PendingConnection" ADD COLUMN     "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
ADD COLUMN     "teamId" TEXT NOT NULL DEFAULT 'default_workspace',
ADD COLUMN     "token" TEXT NOT NULL DEFAULT 'legacy_token';
-- AlterTable
ALTER TABLE "ProcessedMessage" DROP CONSTRAINT "ProcessedMessage_pkey",
DROP COLUMN "id",
ADD CONSTRAINT "ProcessedMessage_pkey" PRIMARY KEY ("messageId");

-- CreateTable
CREATE TABLE "WorkspaceInstall" (
    "teamId" TEXT NOT NULL,
    "botToken" TEXT NOT NULL,
    "channelId" TEXT,
    "teamName" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceInstall_pkey" PRIMARY KEY ("teamId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Mapping_phoneNumber_teamId_key" ON "Mapping"("phoneNumber", "teamId");

-- CreateIndex
CREATE UNIQUE INDEX "PendingConnection_token_key" ON "PendingConnection"("token");
