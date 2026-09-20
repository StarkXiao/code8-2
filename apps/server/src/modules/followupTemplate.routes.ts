import { Router } from 'express';
import {
  createFollowupTemplateItemSchema,
  createFollowupTemplateSchema,
  resolveEffectiveFollowupItems,
  upsertFollowupOverrideSchema,
  updateFollowupTemplateItemSchema,
  type FollowupTemplateItemLike,
  type VagueCategory,
} from '@froa/shared';
import { prisma } from '../db/client';
import { ApiError, notFound } from '../lib/errors';
import { asyncHandler, created, send } from '../lib/http';
import { newId } from '../lib/ids';
import { requireAuth } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { assertWorkspaceRole } from '../services/access';
import { logActivity } from '../services/activity';
import { ensureDefaultTemplate } from '../services/followupTemplate';
import { toFollowupTemplateDto, toFollowupTemplateItemDto } from '../services/serialize';
import { emitToWorkspace } from '../realtime/hub';

export const followupTemplateRouter: Router = Router();

followupTemplateRouter.use(requireAuth);

/* ------------------------------------------------------------------ */
/* 访问校验：条目 → 模板 → 空间，任何 id 都必须落回调用者的空间里        */
/* ------------------------------------------------------------------ */

async function assertTemplateInWorkspace(templateId: string, workspaceId: string) {
  const template = await prisma.followupTemplate.findUnique({
    where: { id: templateId },
    select: { id: true, workspaceId: true },
  });
  if (!template || template.workspaceId !== workspaceId) throw notFound('话术模板');
  return template;
}

async function assertItemRole(userId: string, itemId: string, required: 'viewer' | 'contributor' | 'editor') {
  const item = await prisma.followupTemplateItem.findUnique({
    where: { id: itemId },
    include: { template: { select: { workspaceId: true } } },
  });
  if (!item) throw notFound('话术条目');
  const membership = await assertWorkspaceRole(userId, item.template.workspaceId, required);
  return { item, workspaceId: item.template.workspaceId, membership };
}

/** 把一个空间的所有模板展开成 DTO（含"我"的覆盖状态与生效解析） */
async function listTemplateDtos(workspaceId: string, userId: string) {
  await ensureDefaultTemplate(workspaceId, userId);

  const [templates, items, overrides] = await Promise.all([
    prisma.followupTemplate.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    }),
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
  const resolved = resolveEffectiveFollowupItems(likes, overrides);
  const resolvedByItem = new Map(resolved.map((entry) => [entry.itemId, entry]));
  const overrideByItem = new Map(overrides.map((override) => [override.itemId, override]));

  const itemsByTemplate = new Map<string, typeof items>();
  for (const item of items) {
    const list = itemsByTemplate.get(item.templateId) ?? [];
    list.push(item);
    itemsByTemplate.set(item.templateId, list);
  }

  return templates.map((template) =>
    toFollowupTemplateDto(
      template,
      (itemsByTemplate.get(template.id) ?? []).map((item) =>
        toFollowupTemplateItemDto(
          item,
          overrideByItem.get(item.id) ?? null,
          resolvedByItem.get(item.id)!,
        ),
      ),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* 模板与条目（家族级，editor 以上可管理）                                */
/* ------------------------------------------------------------------ */

followupTemplateRouter.get(
  '/workspaces/:workspaceId/followup-templates',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params;
    await assertWorkspaceRole(req.auth!.userId, workspaceId!, 'viewer');
    send(res, await listTemplateDtos(workspaceId!, req.auth!.userId));
  }),
);

followupTemplateRouter.post(
  '/workspaces/:workspaceId/followup-templates',
  validateBody(createFollowupTemplateSchema),
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params;
    await assertWorkspaceRole(req.auth!.userId, workspaceId!, 'editor');
    const { name } = req.body as { name: string };

    const template = await prisma.followupTemplate.create({
      data: { id: newId(), workspaceId: workspaceId!, name, createdBy: req.auth!.userId },
    });

    await logActivity({
      workspaceId: workspaceId!,
      actorId: req.auth!.userId,
      action: 'followup_template.create',
      entityType: 'followup_template',
      entityId: template.id,
      after: { name },
    });

    created(res, toFollowupTemplateDto(template, []));
  }),
);

followupTemplateRouter.post(
  '/workspaces/:workspaceId/followup-templates/:templateId/items',
  validateBody(createFollowupTemplateItemSchema),
  asyncHandler(async (req, res) => {
    const { workspaceId, templateId } = req.params;
    await assertWorkspaceRole(req.auth!.userId, workspaceId!, 'editor');
    await assertTemplateInWorkspace(templateId!, workspaceId!);

    const body = req.body as {
      category: VagueCategory;
      questionTemplate: string;
      ruleKey?: string | null;
      triggerText?: string | null;
      sortOrder?: number;
    };

    // 一条内置规则在一个模板里只对应一条话术，提前给出明确报错（而不是 409 兜底）
    if (body.ruleKey) {
      const duplicated = await prisma.followupTemplateItem.findFirst({
        where: { templateId: templateId!, ruleKey: body.ruleKey },
        select: { id: true },
      });
      if (duplicated) {
        throw new ApiError('EDIT_CONFLICT', '这条规则在模板里已有对应话术，请直接编辑那一条');
      }
    }

    const maxSort = await prisma.followupTemplateItem.aggregate({
      where: { templateId: templateId! },
      _max: { sortOrder: true },
    });

    const item = await prisma.followupTemplateItem.create({
      data: {
        id: newId(),
        templateId: templateId!,
        category: body.category,
        questionTemplate: body.questionTemplate,
        ruleKey: body.ruleKey ?? null,
        triggerText: body.triggerText ?? null,
        sortOrder: body.sortOrder ?? (maxSort._max.sortOrder ?? 0) + 1,
        createdBy: req.auth!.userId,
      },
    });

    await logActivity({
      workspaceId: workspaceId!,
      actorId: req.auth!.userId,
      action: 'followup_template_item.create',
      entityType: 'followup_template_item',
      entityId: item.id,
      after: { ruleKey: item.ruleKey, triggerText: item.triggerText, category: item.category },
    });

    emitToWorkspace(workspaceId!, 'followup_template:updated', { templateId: templateId! });
    const dtos = await listTemplateDtos(workspaceId!, req.auth!.userId);
    created(res, dtos.flatMap((dto) => dto.items).find((entry) => entry.id === item.id) ?? null);
  }),
);

followupTemplateRouter.patch(
  '/followup-template-items/:itemId',
  validateBody(updateFollowupTemplateItemSchema),
  asyncHandler(async (req, res) => {
    const { itemId } = req.params;
    const { item, workspaceId } = await assertItemRole(req.auth!.userId, itemId!, 'editor');

    const body = req.body as {
      category?: VagueCategory;
      questionTemplate?: string;
      triggerText?: string | null;
      sortOrder?: number;
      enabled?: boolean;
    };

    // 自定义条目不能把触发词清空 —— 清空了它永远不会被触发，等于一条死话术
    const nextTrigger = body.triggerText !== undefined ? body.triggerText : item.triggerText;
    if (!item.ruleKey && !nextTrigger) {
      throw new ApiError('VALIDATION_FAILED', '自定义话术需要保留触发词');
    }

    await prisma.followupTemplateItem.update({
      where: { id: itemId! },
      data: {
        ...(body.category !== undefined ? { category: body.category } : {}),
        ...(body.questionTemplate !== undefined ? { questionTemplate: body.questionTemplate } : {}),
        ...(body.triggerText !== undefined ? { triggerText: body.triggerText } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      },
    });

    await logActivity({
      workspaceId,
      actorId: req.auth!.userId,
      action: 'followup_template_item.update',
      entityType: 'followup_template_item',
      entityId: itemId!,
      before: {
        questionTemplate: item.questionTemplate,
        enabled: item.enabled,
        triggerText: item.triggerText,
      },
      after: body,
    });

    emitToWorkspace(workspaceId, 'followup_template:updated', { templateId: item.templateId });
    const dtos = await listTemplateDtos(workspaceId, req.auth!.userId);
    send(res, dtos.flatMap((dto) => dto.items).find((entry) => entry.id === itemId!) ?? null);
  }),
);

followupTemplateRouter.delete(
  '/followup-template-items/:itemId',
  asyncHandler(async (req, res) => {
    const { itemId } = req.params;
    const { item, workspaceId } = await assertItemRole(req.auth!.userId, itemId!, 'editor');

    await prisma.followupTemplateItem.delete({ where: { id: itemId! } });

    await logActivity({
      workspaceId,
      actorId: req.auth!.userId,
      action: 'followup_template_item.delete',
      entityType: 'followup_template_item',
      entityId: itemId!,
      before: { ruleKey: item.ruleKey, triggerText: item.triggerText },
    });

    emitToWorkspace(workspaceId, 'followup_template:updated', { templateId: item.templateId });
    send(res, { removed: itemId });
  }),
);

/* ------------------------------------------------------------------ */
/* 个人覆盖：换成我的问法 / 临时停用 / 恢复继承                            */
/* ------------------------------------------------------------------ */

/**
 * 覆盖是稀疏的：只存"我和家族不一样"的部分。
 * 补丁语义 —— 没传的字段保持原状（只停用不会弄丢已自定义的文案）；
 * 当文案与停用都被清空时整行删除，回到完全继承状态。
 */
followupTemplateRouter.put(
  '/followup-template-items/:itemId/override',
  validateBody(upsertFollowupOverrideSchema),
  asyncHandler(async (req, res) => {
    const { itemId } = req.params;
    const { workspaceId } = await assertItemRole(req.auth!.userId, itemId!, 'contributor');
    const userId = req.auth!.userId;

    const body = req.body as {
      customQuestion?: string | null;
      disabled?: boolean;
      note?: string | null;
    };

    const existing = await prisma.followupTemplateOverride.findUnique({
      where: { itemId_userId: { itemId: itemId!, userId } },
    });

    // 三态合并：undefined = 保持原值；null/空串 = 清除；有值 = 设置
    const nextCustom =
      body.customQuestion === undefined
        ? (existing?.customQuestion ?? null)
        : body.customQuestion?.trim() || null;
    const nextDisabled =
      body.disabled === undefined ? Boolean(existing?.disabledAt) : body.disabled;
    const nextNote =
      body.note === undefined ? (existing?.note ?? null) : body.note?.trim() || null;

    if (!nextCustom && !nextDisabled) {
      // 没有任何偏离 = 清除覆盖，恢复继承家族文案
      if (existing) {
        await prisma.followupTemplateOverride.delete({ where: { id: existing.id } });
      }
      await logActivity({
        workspaceId,
        actorId: userId,
        action: 'followup_override.clear',
        entityType: 'followup_template_item',
        entityId: itemId!,
      });
      emitToWorkspace(workspaceId, 'followup_template:updated', {});
      send(res, { override: null });
      return;
    }

    const override = await prisma.followupTemplateOverride.upsert({
      where: { itemId_userId: { itemId: itemId!, userId } },
      create: {
        id: newId(),
        itemId: itemId!,
        userId,
        workspaceId,
        customQuestion: nextCustom,
        disabledAt: nextDisabled ? new Date() : null,
        note: nextNote,
      },
      update: {
        customQuestion: nextCustom,
        disabledAt: nextDisabled ? (existing?.disabledAt ?? new Date()) : null,
        note: nextNote,
      },
    });

    await logActivity({
      workspaceId,
      actorId: userId,
      action: 'followup_override.set',
      entityType: 'followup_template_item',
      entityId: itemId!,
      after: { customQuestion: nextCustom, disabled: nextDisabled, note: nextNote },
    });

    emitToWorkspace(workspaceId, 'followup_template:updated', {});
    send(res, {
      override: {
        customQuestion: override.customQuestion,
        disabledAt: override.disabledAt?.toISOString() ?? null,
        note: override.note,
      },
    });
  }),
);

/** 一键恢复继承：等价于 PUT 一个全空覆盖 */
followupTemplateRouter.delete(
  '/followup-template-items/:itemId/override',
  asyncHandler(async (req, res) => {
    const { itemId } = req.params;
    const { workspaceId } = await assertItemRole(req.auth!.userId, itemId!, 'contributor');

    await prisma.followupTemplateOverride.deleteMany({
      where: { itemId: itemId!, userId: req.auth!.userId },
    });

    await logActivity({
      workspaceId,
      actorId: req.auth!.userId,
      action: 'followup_override.clear',
      entityType: 'followup_template_item',
      entityId: itemId!,
    });

    emitToWorkspace(workspaceId, 'followup_template:updated', {});
    send(res, { override: null });
  }),
);
