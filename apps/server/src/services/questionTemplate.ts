import {
  DEFAULT_QUESTION_TEMPLATES,
  isVagueCategory,
  type EffectiveQuestionTemplate,
  type VagueCategory,
} from '@froa/shared';
import { prisma } from '../db/client';
import { newId } from '../lib/ids';

/**
 * 追问话术家族模板的继承逻辑都收敛在这里，路由层只做鉴权与序列化。
 */

/**
 * 新建空间时写入一套家族默认话术。
 * 幂等：空间里只要已经有模板（哪怕全部被删过又重建）就不再补，
 * 否则主人"全部清空"之后下一次有人加入又会被默认话术刷回来。
 */
export async function provisionDefaultQuestionTemplates(
  workspaceId: string,
  createdBy: string,
): Promise<number> {
  const existing = await prisma.questionTemplate.count({ where: { workspaceId } });
  if (existing > 0) return 0;

  await prisma.questionTemplate.createMany({
    data: DEFAULT_QUESTION_TEMPLATES.map((seed, index) => ({
      id: newId(),
      workspaceId,
      category: seed.category,
      title: seed.title,
      content: seed.content,
      sortOrder: index,
      enabled: true,
      createdBy,
    })),
  });

  return DEFAULT_QUESTION_TEMPLATES.length;
}

/**
 * 新人加入空间时"自动套用"。
 *
 * 继承模型里"套用"不需要为成员写任何数据 —— 成员没有个人设置记录时，
 * 看到的就是整套家族话术（零记录 = 全继承）。这个钩子负责两件事：
 *  1. 作为显式语义点，以后继承规则要扩展（比如入群欢迎语）有地方挂；
 *  2. 兼容功能上线前就存在的老空间：它们一条家族模板都没有，
 *     新人加入时由空间所有者名义补上默认话术，老成员下次打开也一并受益。
 */
export async function applyTemplatesForNewMember(
  workspaceId: string,
  ownerId: string,
  _userId: string,
): Promise<void> {
  await provisionDefaultQuestionTemplates(workspaceId, ownerId);
}

type TemplateWithSetting = {
  id: string;
  category: string | null;
  title: string;
  content: string;
  sortOrder: number;
  enabled: boolean;
  memberSettings: {
    mode: string;
    contentOverride: string | null;
    reason: string | null;
  }[];
};

function toEffective(template: TemplateWithSetting): EffectiveQuestionTemplate {
  const setting = template.memberSettings[0] ?? null;
  const mode = setting ? (setting.mode as EffectiveQuestionTemplate['mode']) : 'inherited';

  let effectiveContent: string | null;
  if (!template.enabled || mode === 'disabled') {
    effectiveContent = null;
  } else if (mode === 'override') {
    effectiveContent = setting!.contentOverride;
  } else {
    effectiveContent = template.content;
  }

  return {
    templateId: template.id,
    category: isVagueCategory(template.category) ? template.category : null,
    title: template.title,
    familyContent: template.content,
    effectiveContent,
    mode,
    reason: setting?.reason ?? null,
    familyEnabled: template.enabled,
  };
}

/**
 * 成员视角的家族模板（管理页用）：连家族停用、个人停用的条目一起返回，
 * 每条都带着自己当前的生效状态，页面才能给出"重新启用 / 恢复继承"的入口。
 */
export async function listEffectiveTemplates(
  workspaceId: string,
  userId: string,
): Promise<EffectiveQuestionTemplate[]> {
  const templates = (await prisma.questionTemplate.findMany({
    where: { workspaceId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: {
      memberSettings: { where: { userId }, select: { mode: true, contentOverride: true, reason: true } },
    },
  })) as TemplateWithSetting[];

  return templates.map(toEffective);
}

/**
 * 追问台实际可用的话术：家族启用 + 本人没有停用，按分类过滤
 * （category=null 的通用话术在任何分类下都出现）。
 */
export async function listUsableTemplates(
  workspaceId: string,
  userId: string,
  category?: VagueCategory,
): Promise<EffectiveQuestionTemplate[]> {
  const all = await listEffectiveTemplates(workspaceId, userId);
  return all.filter(
    (template) =>
      template.effectiveContent !== null &&
      (!category || template.category === null || template.category === category),
  );
}
