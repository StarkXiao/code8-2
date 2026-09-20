import { Router } from 'express';
import {
  createWorkspaceSchema,
  joinWorkspaceSchema,
  kitchenReferenceSchema,
  updateMemberRoleSchema,
  type WorkspaceRole,
} from '@froa/shared';
import { prisma } from '../db/client';
import { ApiError, notFound } from '../lib/errors';
import { asyncHandler, created, parsePaging, send, sendList } from '../lib/http';
import { newId, newInviteCode } from '../lib/ids';
import { requireAuth } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { assertWorkspaceRole, getMembership } from '../services/access';
import { logActivity } from '../services/activity';
import { applyTemplatesForNewMember, provisionDefaultQuestionTemplates } from '../services/questionTemplate';
import { toActivityDto, toMemberDto, toReferenceDto, toWorkspaceDto } from '../services/serialize';

export const workspaceRouter: Router = Router();

workspaceRouter.use(requireAuth);

/** 我加入的全部家庭空间 */
workspaceRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const memberships = await prisma.workspaceMember.findMany({
      where: { userId: req.auth!.userId },
      include: { workspace: true },
      orderBy: { joinedAt: 'asc' },
    });
    send(res, memberships.map((member) => toWorkspaceDto(member.workspace, member.role as WorkspaceRole)));
  }),
);

workspaceRouter.post(
  '/',
  validateBody(createWorkspaceSchema),
  asyncHandler(async (req, res) => {
    const { name } = req.body as { name: string };
    const userId = req.auth!.userId;

    const workspace = await prisma.$transaction(async (tx) => {
      const ws = await tx.workspace.create({
        data: { id: newId(), name, ownerId: userId, inviteCode: newInviteCode() },
      });
      await tx.workspaceMember.create({
        data: { id: newId(), workspaceId: ws.id, userId, role: 'owner' },
      });
      return ws;
    });

    // 家族话术模板随空间一起落地：新空间开箱就有一套"该怎么追问"的话术
    await provisionDefaultQuestionTemplates(workspace.id, userId);

    created(res, toWorkspaceDto(workspace, 'owner'));
  }),
);

/** 用邀请码加入 */
workspaceRouter.post(
  '/join',
  validateBody(joinWorkspaceSchema),
  asyncHandler(async (req, res) => {
    const { inviteCode } = req.body as { inviteCode: string };
    const userId = req.auth!.userId;

    const workspace = await prisma.workspace.findUnique({
      where: { inviteCode: inviteCode.toUpperCase() },
    });
    if (!workspace) throw new ApiError('WORKSPACE_INVALID_INVITE');

    const existing = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId } },
    });

    if (existing) {
      send(res, toWorkspaceDto(workspace, existing.role as WorkspaceRole));
      return;
    }

    await prisma.workspaceMember.create({
      data: { id: newId(), workspaceId: workspace.id, userId, role: 'contributor' },
    });

    // 新人加入自动套用：零个人设置 = 完整继承整套家族话术。
    // 对功能上线前的老空间，这一步也会把默认话术补建出来。
    await applyTemplatesForNewMember(workspace.id, workspace.ownerId, userId);

    await logActivity({
      workspaceId: workspace.id,
      actorId: userId,
      action: 'workspace.join',
      entityType: 'workspace',
      entityId: workspace.id,
    });

    created(res, toWorkspaceDto(workspace, 'contributor'));
  }),
);

/** 邀请码重置 */
workspaceRouter.post(
  '/:workspaceId/invite',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params;
    await assertWorkspaceRole(req.auth!.userId, workspaceId!, 'editor');

    const workspace = await prisma.workspace.update({
      where: { id: workspaceId! },
      data: { inviteCode: newInviteCode() },
    });

    send(res, { inviteCode: workspace.inviteCode });
  }),
);

workspaceRouter.get(
  '/:workspaceId',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params;
    const membership = await getMembership(req.auth!.userId, workspaceId!);
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId! } });
    if (!workspace) throw notFound('家庭空间');
    send(res, toWorkspaceDto(workspace, membership.role));
  }),
);

workspaceRouter.get(
  '/:workspaceId/members',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params;
    await getMembership(req.auth!.userId, workspaceId!);

    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId: workspaceId! },
      include: { user: { select: { email: true, displayName: true, avatarUrl: true } } },
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
    });

    send(res, members.map(toMemberDto));
  }),
);

workspaceRouter.patch(
  '/:workspaceId/members/:userId',
  validateBody(updateMemberRoleSchema),
  asyncHandler(async (req, res) => {
    const { workspaceId, userId } = req.params;
    const { role } = req.body as { role: WorkspaceRole };

    const membership = await assertWorkspaceRole(req.auth!.userId, workspaceId!, 'owner');
    if (userId === membership.ownerId) {
      throw new ApiError('VALIDATION_FAILED', '不能修改空间所有者的角色');
    }

    const member = await prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId: workspaceId!, userId: userId! } },
      data: { role },
      include: { user: { select: { email: true, displayName: true, avatarUrl: true } } },
    });

    await logActivity({
      workspaceId: workspaceId!,
      actorId: req.auth!.userId,
      action: 'workspace.member.role.update',
      entityType: 'workspace_member',
      entityId: member.id,
      after: { role },
    });

    send(res, toMemberDto(member));
  }),
);

workspaceRouter.delete(
  '/:workspaceId/members/:userId',
  asyncHandler(async (req, res) => {
    const { workspaceId, userId } = req.params;
    const membership = await assertWorkspaceRole(req.auth!.userId, workspaceId!, 'owner');
    if (userId === membership.ownerId) {
      throw new ApiError('VALIDATION_FAILED', '不能移除空间所有者');
    }

    await prisma.workspaceMember.delete({
      where: { workspaceId_userId: { workspaceId: workspaceId!, userId: userId! } },
    });

    await logActivity({
      workspaceId: workspaceId!,
      actorId: req.auth!.userId,
      action: 'workspace.member.remove',
      entityType: 'workspace_member',
      entityId: userId!,
    });

    send(res, { removed: userId });
  }),
);

// ------------------------------------------------------------------
// 参照物登记（把"一勺""一碗"量化成克）
// ------------------------------------------------------------------

workspaceRouter.get(
  '/:workspaceId/references',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params;
    await getMembership(req.auth!.userId, workspaceId!);

    const references = await prisma.kitchenReference.findMany({
      where: { workspaceId: workspaceId! },
      orderBy: { createdAt: 'asc' },
    });
    send(res, references.map(toReferenceDto));
  }),
);

workspaceRouter.post(
  '/:workspaceId/references',
  validateBody(kitchenReferenceSchema),
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params;
    await assertWorkspaceRole(req.auth!.userId, workspaceId!, 'contributor');
    const { label, amountValue, amountUnit, note } = req.body as {
      label: string;
      amountValue: number;
      amountUnit: string;
      note?: string | null;
    };

    const reference = await prisma.kitchenReference.upsert({
      where: { workspaceId_label: { workspaceId: workspaceId!, label } },
      create: {
        id: newId(),
        workspaceId: workspaceId!,
        label,
        amountValue,
        amountUnit,
        note: note ?? null,
        createdBy: req.auth!.userId,
      },
      update: { amountValue, amountUnit, note: note ?? null },
    });

    created(res, toReferenceDto(reference));
  }),
);

workspaceRouter.delete(
  '/:workspaceId/references/:referenceId',
  asyncHandler(async (req, res) => {
    const { workspaceId, referenceId } = req.params;
    await assertWorkspaceRole(req.auth!.userId, workspaceId!, 'editor');

    // 必须确认这条参照物确实属于本空间：
    // 否则任何空间里的整理者只要拿到 id，就能删掉别人家的参照物。
    const reference = await prisma.kitchenReference.findUnique({
      where: { id: referenceId! },
      select: { workspaceId: true },
    });
    if (!reference || reference.workspaceId !== workspaceId) throw notFound('参照物');

    await prisma.kitchenReference.delete({ where: { id: referenceId! } });
    send(res, { removed: referenceId });
  }),
);

// ------------------------------------------------------------------
// 审计日志
// ------------------------------------------------------------------

workspaceRouter.get(
  '/:workspaceId/activity',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params;
    await getMembership(req.auth!.userId, workspaceId!);
    const { skip, take, page, pageSize } = parsePaging(req, 50);

    const [logs, total] = await Promise.all([
      prisma.activityLog.findMany({
        where: { workspaceId: workspaceId! },
        include: { actor: { select: { id: true, displayName: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.activityLog.count({ where: { workspaceId: workspaceId! } }),
    ]);

    sendList(res, logs.map(toActivityDto), { total, page, pageSize });
  }),
);
