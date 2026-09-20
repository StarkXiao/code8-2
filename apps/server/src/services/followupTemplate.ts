import {
  DEFAULT_TEMPLATE_NAME,
  defaultFollowupTemplateItems,
  resolveEffectiveFollowupItems,
  type FollowupTemplateItemLike,
  type ResolvedFollowupItem,
  type VagueCategory,
} from '@froa/shared';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/client';
import { newId } from '../lib/ids';

/**
 * 追问话术模板的数据访问层。
 *
 * 继承模型：家族模板是空间级资产，个人覆盖稀疏存储。
 * 新人加入时不需要写入任何行 —— 没有覆盖就完整继承家族文案，
 * 这就是"新人自动套用"的实现方式（引用继承，而不是加入时复制一份）。
 */

/**
 * 确保空间至少有一个默认话术模板（幂等）。
 * 两个调用时机：
 *   1. 创建空间时（同事务播种）；
 *   2. 老空间首次读模板/取建议时（懒补齐 —— 该功能上线前已存在的空间没有模板）。
 */
export async function ensureDefaultTemplate(workspaceId: string, userId: string): Promise<void> {
  const existing = await prisma.followupTemplate.findFirst({
    where: { workspaceId },
    select: { id: true },
  });
  if (existing) return;

  const seeds = defaultFollowupTemplateItems();
  try {
    await prisma.followupTemplate.create({
      data: {
        id: newId(),
        workspaceId,
        name: DEFAULT_TEMPLATE_NAME,
        createdBy: userId,
        items: {
          create: seeds.map((seed) => ({
            id: newId(),
            ruleKey: seed.ruleKey,
            category: seed.category,
            triggerText: seed.triggerText,
            questionTemplate: seed.questionTemplate,
            sortOrder: seed.sortOrder,
            createdBy: userId,
          })),
        },
      },
    });
  } catch (error) {
    // 并发首次访问时两个请求同时播种：唯一约束 (workspaceId, name) 会拦下后者，
    // 后者直接复用先创建好的那份即可。其它错误（如库不可用）照常抛出。
    const isUniqueRace =
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
    if (!isUniqueRace) throw error;
  }
}

/** 解析"我"在某个空间里看到的全部生效话术（含停用标记，供管理界面与建议接口使用） */
export async function getResolvedItems(
  workspaceId: string,
  userId: string,
): Promise<ResolvedFollowupItem[]> {
  await ensureDefaultTemplate(workspaceId, userId);

  const [items, overrides] = await Promise.all([
    prisma.followupTemplateItem.findMany({
      where: { template: { workspaceId } },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    }),
    prisma.followupTemplateOverride.findMany({
      where: { workspaceId, userId },
    }),
  ]);

  const likes: FollowupTemplateItemLike[] = items.map((item) => ({
    id: item.id,
    ruleKey: item.ruleKey,
    category: item.category as VagueCategory,
    triggerText: item.triggerText,
    questionTemplate: item.questionTemplate,
    sortOrder: item.sortOrder,
    enabled: item.enabled,
  }));

  return resolveEffectiveFollowupItems(likes, overrides);
}
