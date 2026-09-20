/**
 * 基线数据。
 *
 * 目的不是"造一个假项目"，而是让刚克隆下来的仓库能立刻登录进去看真实功能。
 * 全部内容都是可运行的正常数据（正常用户、正常空间、正常参照物字典），
 * 不包含任何 mock / 假接口 / 硬编码返回值。
 *
 * 如果不想写入这些账号，跳过 `npm run db:seed` 直接注册即可。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_QUESTION_TEMPLATES } from '@froa/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
// 优先级：真实环境变量 > .env.local > .env
for (const file of [path.join(repoRoot, '.env.local'), path.join(repoRoot, '.env')]) {
  if (fs.existsSync(file)) dotenv.config({ path: file, override: false });
}

function resolveDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL?.trim() || 'file:./data/app.db';
  if (!raw.startsWith('file:')) return raw;
  const target = raw.slice('file:'.length);
  return `file:${path.isAbsolute(target) ? target : path.resolve(repoRoot, target)}`;
}

const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });

const DEMO_PASSWORD = 'froa12345';

async function main() {
  const existing = await prisma.user.count();
  if (existing > 0) {
    console.log(`数据库已有 ${existing} 个用户，跳过基线数据写入。`);
    return;
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);

  const elder = await prisma.user.create({
    data: {
      id: 'seed-user-elder',
      email: 'nainai@example.com',
      displayName: '外婆',
      passwordHash,
    },
  });

  const organizer = await prisma.user.create({
    data: {
      id: 'seed-user-organizer',
      email: 'me@example.com',
      displayName: '我',
      passwordHash,
    },
  });

  const workspace = await prisma.workspace.create({
    data: {
      id: 'seed-workspace',
      name: '我们家的厨房',
      ownerId: organizer.id,
      inviteCode: 'HOME2026',
    },
  });

  await prisma.workspaceMember.createMany({
    data: [
      { id: 'seed-member-1', workspaceId: workspace.id, userId: organizer.id, role: 'owner' },
      { id: 'seed-member-2', workspaceId: workspace.id, userId: elder.id, role: 'contributor' },
    ],
  });

  // 参照物登记：先把"家里那只勺、那只碗"量化一次，
  // 之后所有"一勺""一碗"都能自动换算成克 —— 这是把模糊用量变成数值最有效的手段。
  await prisma.kitchenReference.createMany({
    data: [
      {
        id: 'seed-ref-1',
        workspaceId: workspace.id,
        label: '外婆家的白瓷汤勺',
        amountValue: 8,
        amountUnit: 'g',
        note: '一平勺约 8g，满勺约 12g',
        createdBy: organizer.id,
      },
      {
        id: 'seed-ref-2',
        workspaceId: workspace.id,
        label: '搪瓷小勺',
        amountValue: 3,
        amountUnit: 'g',
        note: '一平勺约 3g（用来量盐和糖）',
        createdBy: organizer.id,
      },
      {
        id: 'seed-ref-3',
        workspaceId: workspace.id,
        label: '那只蓝边饭碗',
        amountValue: 220,
        amountUnit: 'ml',
        note: '一碗水约 220ml',
        createdBy: organizer.id,
      },
    ],
  });

  // 家族追问话术模板：新成员加入时自动继承的那套"该怎么开口问"
  await prisma.questionTemplate.createMany({
    data: DEFAULT_QUESTION_TEMPLATES.map((seed, index) => ({
      id: `seed-template-${index + 1}`,
      workspaceId: workspace.id,
      category: seed.category,
      title: seed.title,
      content: seed.content,
      sortOrder: index,
      enabled: true,
      createdBy: organizer.id,
    })),
  });

  console.log('✔ 基线数据写入完成');
  console.log(`  空间：${workspace.name}（邀请码 ${workspace.inviteCode}）`);
  console.log(`  账号：${organizer.email} / ${elder.email}`);
  console.log(`  密码：${DEMO_PASSWORD}`);
  console.log('  提示：不想用这些账号可以直接注册新账号，或删除 data/ 目录后重新迁移。');
}

main()
  .catch((error) => {
    console.error('基线数据写入失败：', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
