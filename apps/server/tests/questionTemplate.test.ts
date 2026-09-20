/**
 * 追问话术家族模板 —— 集成测试。
 *
 * 覆盖需求的四件事：
 *   1. 家族模板随空间创建而存在，新人加入自动继承；
 *   2. 个人可以覆盖某一条（只影响自己）；
 *   3. 个人可以临时停用某一条（只影响自己），删除个人设置即恢复继承；
 *   4. 家族级停用对所有成员生效，整理者才能管理家族模板。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/db/client';

const app = createApp();

interface Session {
  token: string;
  userId: string;
}

async function register(email: string, displayName: string): Promise<Session> {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'froa12345', displayName })
    .expect(201);
  return {
    token: response.body.data.tokens.accessToken as string,
    userId: response.body.data.user.id as string,
  };
}

const auth = (session: Session) => ({ Authorization: `Bearer ${session.token}` });

type TemplateRow = {
  templateId: string;
  title: string;
  category: string | null;
  mode: string;
  reason: string | null;
  familyContent: string;
  effectiveContent: string | null;
  familyEnabled: boolean;
};

/** 取出响应里的话术列表 */
function templateRows(response: { body: { data: unknown } }): TemplateRow[] {
  return response.body.data as TemplateRow[];
}

/** 从列表响应里按标题找到一条 */
function findByTitle(rows: TemplateRow[], title: string): TemplateRow {
  const row = rows.find((item) => item.title === title);
  if (!row) throw new Error(`测试数据里找不到标题为「${title}」的话术`);
  return row;
}

describe('追问话术家族模板', () => {
  let organizer: Session;
  let elder: Session;
  let outsider: Session;
  let workspaceId = '';

  beforeAll(async () => {
    organizer = await register('qt-organizer@e2e.test', '整理者');
    elder = await register('qt-elder@e2e.test', '外婆');
    outsider = await register('qt-outsider@e2e.test', '外人');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('1. 创建空间时自动写入一套家族默认话术，且包含通用话术与各分类话术', async () => {
    const ws = await request(app)
      .post('/api/workspaces')
      .set(auth(organizer))
      .send({ name: '话术测试厨房' })
      .expect(201);
    workspaceId = ws.body.data.id;

    const list = await request(app)
      .get(`/api/workspaces/${workspaceId}/question-templates`)
      .set(auth(organizer))
      .expect(200);

    const rows = list.body.data as {
      templateId: string;
      category: string | null;
      mode: string;
      effectiveContent: string | null;
      familyEnabled: boolean;
    }[];

    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows.some((row) => row.category === null)).toBe(true);
    expect(rows.some((row) => row.category === 'amount')).toBe(true);
    // 零个人设置 = 全部完整继承
    expect(rows.every((row) => row.mode === 'inherited')).toBe(true);
    expect(rows.every((row) => row.effectiveContent !== null)).toBe(true);
  });

  it('2. 新人用邀请码加入后自动套用：看到的话术与老成员一致，无需任何额外操作', async () => {
    const inviteCode = (
      await request(app).get(`/api/workspaces/${workspaceId}`).set(auth(organizer)).expect(200)
    ).body.data.inviteCode as string;

    await request(app)
      .post('/api/workspaces/join')
      .set(auth(elder))
      .send({ inviteCode })
      .expect(201);

    const [mine, theirs] = await Promise.all([
      request(app)
        .get(`/api/workspaces/${workspaceId}/question-templates/usable`)
        .set(auth(organizer))
        .expect(200),
      request(app)
        .get(`/api/workspaces/${workspaceId}/question-templates/usable`)
        .set(auth(elder))
        .expect(200),
    ]);

    const mineIds = (mine.body.data as { templateId: string }[]).map((row) => row.templateId).sort();
    const theirIds = (theirs.body.data as { templateId: string }[]).map((row) => row.templateId).sort();
    expect(theirIds).toEqual(mineIds);
  });

  it('3. 空间外成员既看不到也不能管理别人家的话术', async () => {
    await request(app)
      .get(`/api/workspaces/${workspaceId}/question-templates`)
      .set(auth(outsider))
      .expect(403);

    await request(app)
      .post(`/api/workspaces/${workspaceId}/question-templates`)
      .set(auth(outsider))
      .send({ title: '闯入', content: '不该存在' })
      .expect(403);
  });

  it('4. 贡献者不能改家族模板，但可以维护只属于自己的个人设置', async () => {
    await request(app)
      .post(`/api/workspaces/${workspaceId}/question-templates`)
      .set(auth(elder))
      .send({ title: '外婆想改家族', content: '改不动' })
      .expect(403);

    const all = await request(app)
      .get(`/api/workspaces/${workspaceId}/question-templates`)
      .set(auth(elder))
      .expect(200);
    const targetId = findByTitle(templateRows(all), '用量：换成克数').templateId;

    const setting = await request(app)
      .put(`/api/workspaces/${workspaceId}/question-templates/${targetId}/setting`)
      .set(auth(elder))
      .send({ mode: 'override', contentOverride: '糖放我那只小瓷勺平平一勺就行。' })
      .expect(200);

    expect(setting.body.data.mode).toBe('override');
  });

  it('5. 个人覆盖只影响本人：本人看到新话术，其他成员仍看到家族原话', async () => {
    const all = await request(app)
      .get(`/api/workspaces/${workspaceId}/question-templates`)
      .set(auth(elder))
      .expect(200);
    const target = findByTitle(templateRows(all), '用量：换成克数');

    expect(target.mode).toBe('override');
    expect(target.effectiveContent).toBe('糖放我那只小瓷勺平平一勺就行。');
    expect(target.familyContent).not.toBe(target.effectiveContent);

    const ownerView = await request(app)
      .get(`/api/workspaces/${workspaceId}/question-templates`)
      .set(auth(organizer))
      .expect(200);
    const ownerTarget = findByTitle(templateRows(ownerView), '用量：换成克数');
    expect(ownerTarget.mode).toBe('inherited');
    expect(ownerTarget.effectiveContent).not.toBe('糖放我那只小瓷勺平平一勺就行。');

    // 覆盖模式必须带自己的话术内容
    await request(app)
      .put(`/api/workspaces/${workspaceId}/question-templates/${target.templateId}/setting`)
      .set(auth(elder))
      .send({ mode: 'override' })
      .expect(400);
  });

  it('6. 临时停用只影响本人：本人的 usable 列表少一条，其他成员不受影响', async () => {
    const beforeElder = await request(app)
      .get(`/api/workspaces/${workspaceId}/question-templates/usable?category=time`)
      .set(auth(elder))
      .expect(200);
    const timeTitle = '时间：大概几分钟';
    const targetId = findByTitle(templateRows(beforeElder), timeTitle).templateId;

    await request(app)
      .put(`/api/workspaces/${workspaceId}/question-templates/${targetId}/setting`)
      .set(auth(elder))
      .send({ mode: 'disabled', reason: '外婆嫌这么问太生分' })
      .expect(200);

    const afterElder = await request(app)
      .get(`/api/workspaces/${workspaceId}/question-templates/usable?category=time`)
      .set(auth(elder))
      .expect(200);
    expect(
      (afterElder.body.data as { templateId: string }[]).some((row) => row.templateId === targetId),
    ).toBe(false);

    const ownerTime = await request(app)
      .get(`/api/workspaces/${workspaceId}/question-templates/usable?category=time`)
      .set(auth(organizer))
      .expect(200);
    expect(
      (ownerTime.body.data as { templateId: string }[]).some((row) => row.templateId === targetId),
    ).toBe(true);

    // 管理视角仍能看到它，并带着停用原因，方便日后恢复
    const elderManage = await request(app)
      .get(`/api/workspaces/${workspaceId}/question-templates`)
      .set(auth(elder))
      .expect(200);
    const disabledRow = findByTitle(templateRows(elderManage), timeTitle);
    expect(disabledRow.mode).toBe('disabled');
    expect(disabledRow.reason).toBe('外婆嫌这么问太生分');
  });

  it('7. 删除个人设置即恢复继承：覆盖与停用都能一键找回家族原话', async () => {
    const all = await request(app)
      .get(`/api/workspaces/${workspaceId}/question-templates`)
      .set(auth(elder))
      .expect(200);

    for (const title of ['用量：换成克数', '时间：大概几分钟']) {
      const target = findByTitle(templateRows(all), title);
      await request(app)
        .delete(`/api/workspaces/${workspaceId}/question-templates/${target.templateId}/setting`)
        .set(auth(elder))
        .expect(200);
    }

    const after = await request(app)
      .get(`/api/workspaces/${workspaceId}/question-templates`)
      .set(auth(elder))
      .expect(200);
    expect(
      (after.body.data as { mode: string }[]).every((row) => row.mode === 'inherited'),
    ).toBe(true);

    // 本来就没有个人设置时，重置应当明确报错而不是假装成功
    const anyId = (after.body.data as { templateId: string }[])[0]!.templateId;
    await request(app)
      .delete(`/api/workspaces/${workspaceId}/question-templates/${anyId}/setting`)
      .set(auth(elder))
      .expect(400);
  });

  it('8. 整理者新建与家族级停用：停用后所有成员都不再看到，重新启用即恢复', async () => {
    const created = await request(app)
      .post(`/api/workspaces/${workspaceId}/question-templates`)
      .set(auth(organizer))
      .send({
        category: 'heat',
        title: '火候：冒烟就转小火',
        content: '{称呼}，看到锅里冒青烟就立刻转小火，对吗？',
      })
      .expect(201);
    const templateId = created.body.data.id as string;
    expect(created.body.data.enabled).toBe(true);
    expect(created.body.data.category).toBe('heat');

    const visible = await request(app)
      .get(`/api/workspaces/${workspaceId}/question-templates/usable?category=heat`)
      .set(auth(elder))
      .expect(200);
    expect((visible.body.data as { templateId: string }[]).map((r) => r.templateId)).toContain(templateId);

    await request(app)
      .patch(`/api/workspaces/${workspaceId}/question-templates/${templateId}`)
      .set(auth(organizer))
      .send({ enabled: false })
      .expect(200);

    for (const session of [organizer, elder]) {
      const res = await request(app)
        .get(`/api/workspaces/${workspaceId}/question-templates/usable?category=heat`)
        .set(auth(session))
        .expect(200);
      expect((res.body.data as { templateId: string }[]).map((r) => r.templateId)).not.toContain(templateId);
    }

    await request(app)
      .patch(`/api/workspaces/${workspaceId}/question-templates/${templateId}`)
      .set(auth(organizer))
      .send({ enabled: true })
      .expect(200);

    const reEnabled = await request(app)
      .get(`/api/workspaces/${workspaceId}/question-templates/usable?category=heat`)
      .set(auth(elder))
      .expect(200);
    expect((reEnabled.body.data as { templateId: string }[]).map((r) => r.templateId)).toContain(templateId);
  });

  it('9. 乐观锁：两个人同时编辑同一条家族话术，后提交的收到 409', async () => {
    const created = await request(app)
      .post(`/api/workspaces/${workspaceId}/question-templates`)
      .set(auth(organizer))
      .send({ category: null, title: '乐观锁用例', content: '初始内容' })
      .expect(201);
    const templateId = created.body.data.id as string;
    const originalUpdatedAt = created.body.data.updatedAt as string;

    // 甲先改
    await request(app)
      .patch(`/api/workspaces/${workspaceId}/question-templates/${templateId}`)
      .set(auth(organizer))
      .send({ title: '乐观锁用例', content: '甲改过的内容', expectedUpdatedAt: originalUpdatedAt })
      .expect(200);

    // 乙还拿着旧时间戳提交 —— 必须被 409 拦下来，不能静默覆盖
    const stale = await request(app)
      .patch(`/api/workspaces/${workspaceId}/question-templates/${templateId}`)
      .set(auth(organizer))
      .send({ title: '乙的标题', content: '乙的内容', expectedUpdatedAt: originalUpdatedAt })
      .expect(409);
    expect(stale.body.error.code).toBe('EDIT_CONFLICT');

    // 不带时间戳时退化为最后写入者胜，老客户端仍可用
    await request(app)
      .patch(`/api/workspaces/${workspaceId}/question-templates/${templateId}`)
      .set(auth(organizer))
      .send({ title: '老客户端也能改' })
      .expect(200);
  });
});
