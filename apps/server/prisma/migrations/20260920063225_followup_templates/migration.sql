-- CreateTable
CREATE TABLE "FollowupTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FollowupTemplate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FollowupTemplateItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateId" TEXT NOT NULL,
    "ruleKey" TEXT,
    "category" TEXT NOT NULL,
    "triggerText" TEXT,
    "questionTemplate" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FollowupTemplateItem_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "FollowupTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FollowupTemplateOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "customQuestion" TEXT,
    "disabledAt" DATETIME,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FollowupTemplateOverride_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "FollowupTemplateItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FollowupTemplateOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FollowupTemplateOverride_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "FollowupTemplate_workspaceId_name_key" ON "FollowupTemplate"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "FollowupTemplateItem_templateId_sortOrder_idx" ON "FollowupTemplateItem"("templateId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "FollowupTemplateItem_templateId_ruleKey_key" ON "FollowupTemplateItem"("templateId", "ruleKey");

-- CreateIndex
CREATE INDEX "FollowupTemplateOverride_workspaceId_userId_idx" ON "FollowupTemplateOverride"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "FollowupTemplateOverride_itemId_userId_key" ON "FollowupTemplateOverride"("itemId", "userId");
