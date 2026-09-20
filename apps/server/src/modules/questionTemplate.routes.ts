import { Router } from 'express';
import {
  createQuestionTemplateSchema,
  updateQuestionTemplateSchema,
  upsertTemplateSettingSchema,
  VAGUE_CATEGORIES,
  type VagueCategory,
} from '@froa/shared';
import { prisma } from '../db/client';
import { ApiError, notFound } from '../lib/errors';
import { asyncHandler, created, send } from '../lib/http';
import { newId } from '../lib/ids';
import { assertNotStale } from '../lib/concurrency';
import { requireAuth } from '../middleware/auth';
import { validateBody, validateQuery, queryOf } from '../middleware/validate';
import { getMembership, assertWorkspaceRole } from '../services/access';
import { logActivity } from '../services/activity';
import { emitToWorkspace } from '../realtime/hub';
import { listEffectiveTemplates, listUsableTemplates } from '../services/questionTemplate';
import { toQuestionTemplateDto, toTemplateSettingDto } from '../services/serialize';
import { z } from 'zod';

export const questionTemplateRouter: Router = Router();

questionTemplateRouter.use(requireAuth);

/** 确认模板确实属于该空间，防止拿别家空间的 templateId 改数据 */
async function assertTemplateInWorkspace(templateId: string, workspaceId: string) {
  const template = await prisma.questionTemplate.findUnique({
    where: { id: templateId },
    select: { id: true, workspaceId: true },
  });
  if (!template || template.workspaceId !== workspaceId) throw notFound('追问话术');
}

const usableQuerySchema = z.object({
  category: z.enum(VAGUE_CATEGORIES).optional(),
});

/* ------------------------------------------------------------------ */
/* 家族模板管理                                                        */
/* ------------------------------------------------------------------ */

/**
 * 管理页：列出空间里全部家族模板 + 我对每条的个人设置（含已停用的）。
 * 任何成员都能看 —— 个人停用/覆盖入口也在这份数据上。
 */
questionTemplateRouter.get(
  '/workspaces/:workspaceId/question-templates',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params;
    await getMembership(req.auth!.userId, workspaceId!);
    const templates = await listEffectiveTemplates(workspaceId!, req.auth!.userId);
    send(res, templates);
  }),
);

/**
 * 追问台：只返回"我现在真能用"的话术（家族启用、本人未停用），
 * category 过滤时通用话术（category=null）始终带上。
 */
questionTemplateRouter.get(
  '/workspaces/:workspaceId/question-templates/usable',
  validateQuery(usableQuerySchema),
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params;
    await getMembership(req.auth!.userId, workspaceId!);
    const { category } = queryOf(req, usableQuerySchema);
    const templates = await listUsableTemplates(workspaceId!, req.auth!.userId, category);
    send(res, templates);
  }),
);

questionTemplateRouter.post(
  '/workspaces/:workspaceId/question-templates',
  validateBody(createQuestionTemplateSchema),
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params;
    await assertWorkspaceRole(req.auth!.userId, workspaceId!, 'editor');

    const body = req.body as {
      category: VagueCategory | null | undefined;
      title: string;
      content: string;
      sortOrder?: number;
      enabled?: boolean;
    };

    const maxOrder = await prisma.questionTemplate.aggregate({
      where: { workspaceId: workspaceId! },
      _max: { sortOrder: true },
    });

    const template = await prisma.questionTemplate.create({
      data: {
        id: newId(),
        workspaceId: workspaceId!,
        category: body.category ?? null,
        title: body.title,
        content: body.content,
        sortOrder: body.sortOrder ?? (maxOrder._max.sortOrder ?? -1) + 1,
        enabled: body.enabled ?? true,
        createdBy: req.auth!.userId,
      },
    });

    await logActivity({
      workspaceId: workspaceId!,
      actorId: req.auth!.userId,
      action: 'question_template.create',
      entityType: 'question_template',
      entityId: template.id,
      after: { title: template.title, category: template.category },
    });

    emitToWorkspace(workspaceId!, 'question_template:changed', { templateId: template.id });
    created(res, toQuestionTemplateDto(template));
  }),
);

questionTemplateRouter.patch(
  '/workspaces/:workspaceId/question-templates/:templateId',
  validateBody(updateQuestionTemplateSchema),
  asyncHandler(async (req, res) => {
    const { workspaceId, templateId } = req.params;
    await assertWorkspaceRole(req.auth!.userId, workspaceId!, 'editor');
    await assertTemplateInWorkspace(templateId!, workspaceId!);

    const before = await prisma.questionTemplate.findUnique({ where: { id: templateId! } });
    if (!before) throw notFound('追问话术');
    assertNotStale(before.updatedAt, req.body.expectedUpdatedAt as string | undefined);

    const body = req.body as Record<string, unknown>;
    const template = await prisma.questionTemplate.update({
      where: { id: templateId! },
      data: {
        ...(body.category !== undefined ? { category: (body.category as string | null) ?? null } : {}),
        ...(body.title !== undefined ? { title: body.title as string } : {}),
        ...(body.content !== undefined ? { content: body.content as string } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder as number } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}),
      },
    });

    await logActivity({
      workspaceId: workspaceId!,
      actorId: req.auth!.userId,
      action: 'question_template.update',
      entityType: 'question_template',
      entityId: template.id,
      before: { title: before.title, enabled: before.enabled },
      after: { title: template.title, enabled: template.enabled },
    });

    emitToWorkspace(workspaceId!, 'question_template:changed', { templateId: template.id });
    send(res, toQuestionTemplateDto(template));
  }),
);

questionTemplateRouter.delete(
  '/workspaces/:workspaceId/question-templates/:templateId',
  asyncHandler(async (req, res) => {
    const { workspaceId, templateId } = req.params;
    await assertWorkspaceRole(req.auth!.userId, workspaceId!, 'editor');
    await assertTemplateInWorkspace(templateId!, workspaceId!);

    await prisma.questionTemplate.delete({ where: { id: templateId! } });

    await logActivity({
      workspaceId: workspaceId!,
      actorId: req.auth!.userId,
      action: 'question_template.delete',
      entityType: 'question_template',
      entityId: templateId!,
    });

    emitToWorkspace(workspaceId!, 'question_template:changed', { templateId: templateId!, removed: true });
    send(res, { removed: templateId });
  }),
);

/* ------------------------------------------------------------------ */
/* 个人覆盖 / 临时停用（只对本人生效，不要求整理者权限）                */
/* ------------------------------------------------------------------ */

questionTemplateRouter.put(
  '/workspaces/:workspaceId/question-templates/:templateId/setting',
  validateBody(upsertTemplateSettingSchema),
  asyncHandler(async (req, res) => {
    const { workspaceId, templateId } = req.params;
    // 是空间成员即可：自己的话术偏好不需要整理者权限
    await getMembership(req.auth!.userId, workspaceId!);
    await assertTemplateInWorkspace(templateId!, workspaceId!);

    const body = req.body as { mode: 'override' | 'disabled'; contentOverride?: string | null; reason?: string | null };
    const userId = req.auth!.userId;

    const setting = await prisma.questionTemplateMemberSetting.upsert({
      where: { templateId_userId: { templateId: templateId!, userId } },
      create: {
        id: newId(),
        templateId: templateId!,
        userId,
        mode: body.mode,
        contentOverride: body.mode === 'override' ? body.contentOverride ?? null : null,
        reason: body.reason ?? null,
      },
      update: {
        mode: body.mode,
        contentOverride: body.mode === 'override' ? body.contentOverride ?? null : null,
        reason: body.reason ?? null,
      },
    });

    await logActivity({
      workspaceId: workspaceId!,
      actorId: userId,
      action: 'question_template.setting.upsert',
      entityType: 'question_template_setting',
      entityId: setting.id,
      after: { templateId: templateId!, mode: setting.mode },
    });

    send(res, toTemplateSettingDto(setting));
  }),
);

/** 删掉个人设置 = 恢复完全继承家族模板 */
questionTemplateRouter.delete(
  '/workspaces/:workspaceId/question-templates/:templateId/setting',
  asyncHandler(async (req, res) => {
    const { workspaceId, templateId } = req.params;
    await getMembership(req.auth!.userId, workspaceId!);
    await assertTemplateInWorkspace(templateId!, workspaceId!);

    const deleted = await prisma.questionTemplateMemberSetting.deleteMany({
      where: { templateId: templateId!, userId: req.auth!.userId },
    });
    if (deleted.count === 0) throw new ApiError('VALIDATION_FAILED', '你没有对这条话术做过个人设置');

    await logActivity({
      workspaceId: workspaceId!,
      actorId: req.auth!.userId,
      action: 'question_template.setting.reset',
      entityType: 'question_template_setting',
      entityId: templateId!,
    });

    send(res, { reset: templateId });
  }),
);
