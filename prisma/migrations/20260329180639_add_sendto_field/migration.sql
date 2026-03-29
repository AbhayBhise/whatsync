/*
  Warnings:

  - Added the required column `sendTo` to the `Mapping` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Mapping" ADD COLUMN "sendTo" TEXT NOT NULL DEFAULT '';
