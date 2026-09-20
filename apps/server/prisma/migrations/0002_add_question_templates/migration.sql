-- CreateTable
CREATE TABLE "QuestionTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "category" TEXT,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "QuestionTemplate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "QuestionTemplate_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QuestionTemplateMemberSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "contentOverride" TEXT,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "QuestionTemplateMemberSetting_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "QuestionTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "QuestionTemplateMemberSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "QuestionTemplate_workspaceId_enabled_idx" ON "QuestionTemplate"("workspaceId", "enabled");

-- CreateIndex
CREATE INDEX "QuestionTemplate_workspaceId_category_idx" ON "QuestionTemplate"("workspaceId", "category");

-- CreateIndex
CREATE INDEX "QuestionTemplateMemberSetting_userId_idx" ON "QuestionTemplateMemberSetting"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionTemplateMemberSetting_templateId_userId_key" ON "QuestionTemplateMemberSetting"("templateId", "userId");
