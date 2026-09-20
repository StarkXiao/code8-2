/**
 * 追问话术模板 —— 家族模板继承 / 个人覆盖 / 临时停用。
 *
 * 核心语义：
 *   1. 家族模板是空间级资产，创建空间时自动播种，新人加入自动继承（无需任何写入）；
 *   2. 个人可以"换成我的问法"（覆盖）或"临时停用"某一条，互不影响别人；
 *   3. 家族文案更新后，没覆盖过的人自动跟上 —— 继承是引用，不是复制。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { FALLBACK_RULE_KEY, NORMALIZATION_RULES } from '@froa/shared';
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

async function createWorkspace(session: Session, name: string): Promise<string> {
  const response = await request(app)
    .post('/api/workspaces')
    .set(auth(session))
    .send({ name })
    .expect(201);
  return response.body.data.id as string;
}

async function listTemplates(session: Session, workspaceId: string) {
  const response = await request(app)
    .get(`/api/workspaces/${workspaceId}/followup-templates`)
    .set(auth(session))
    .expect(200);
  return response.body.data as {
    id: string;
    name: string;
    items: {
      id: string;
      ruleKey: string | null;
      category: string;
      triggerText: string | null;
      questionTemplate: string;
      enabled: boolean;
      myOverride: { customQuestion: string | null; disabledAt: string | null } | null;
      effective: { questionTemplate: string; source: string; active: boolean };
    }[];
  }[];
}

async function suggest(session: Session, recipeId: string, text: string) {
  const response = await request(app)
    .get(`/api/recipes/${recipeId}/vague-items/suggest`)
    .query({ text })
    .set(auth(session))
    .expect(200);
  return response.body.data as {
    matches: { ruleId: string; question: string; source: string; itemId: string | null }[];
    fallbackQuestionTemplate: string | null;
    count: number;
  };
}

describe('追问话术模板：家族继承 + 个人覆盖 + 临时停用', () => {
  let owner: Session;
  let elder: Session;
  let outsider: Session;
  let workspaceId = '';
  let recipeId = '';
  let tinyAmountItemId = ''; // amount.tiny 规则对应的模板条目

  beforeAll(async () => {
    owner = await register('tpl-owner@test.dev', '整理者');
    elder = await register('tpl-elder@test.dev', '外婆');
    outsider = await register('tpl-outsider@test.dev', '隔壁老王');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('1. 创建空间时自动播种默认话术模板（内置规则 + 兜底话术）', async () => {
    workspaceId = await createWorkspace(owner, '话术测试厨房');

    const templates = await listTemplates(owner, workspaceId);
    expect(templates).toHaveLength(1);
    expect(templates[0]!.name).toBe('家族默认话术');

    const ruleKeys = templates[0]!.items.map((item) => item.ruleKey);
    // 每条内置模糊规则都有一条对应话术，外加一条兜底
    for (const rule of NORMALIZATION_RULES) expect(ruleKeys).toContain(rule.id);
    expect(ruleKeys).toContain(FALLBACK_RULE_KEY);

    // 初始状态：没有个人覆盖，生效文案 = 家族文案
    const tiny = templates[0]!.items.find((item) => item.ruleKey === 'amount.tiny')!;
    tinyAmountItemId = tiny.id;
    expect(tiny.myOverride).toBeNull();
    expect(tiny.effective.source).toBe('family');
    expect(tiny.effective.active).toBe(true);
    expect(tiny.effective.questionTemplate).toBe(tiny.questionTemplate);
  });

  it('2. 播种是幂等的，老空间没有模板时会懒补齐', async () => {
    await listTemplates(owner, workspaceId);
    await listTemplates(owner, workspaceId);
    expect(await prisma.followupTemplate.count({ where: { workspaceId } })).toBe(1);

    // 模拟"功能上线前就存在的老空间"：删掉它的全部模板
    await prisma.followupTemplate.deleteMany({ where: { workspaceId } });
    const templates = await listTemplates(owner, workspaceId);
    expect(templates).toHaveLength(1);
    expect(templates[0]!.items.length).toBeGreaterThan(0);
    tinyAmountItemId = templates[0]!.items.find((item) => item.ruleKey === 'amount.tiny')!.id;
  });

  it('3. 新人加入时自动套用家族模板，不需要任何设置', async () => {
    const workspace = await request(app)
      .get(`/api/workspaces/${workspaceId}`)
      .set(auth(owner))
      .expect(200);
    await request(app)
      .post('/api/workspaces/join')
      .set(auth(elder))
      .send({ inviteCode: workspace.body.data.inviteCode })
      .expect(201);

    // 新人从未配置过任何东西，但看到的话术与家族完全一致
    const mine = await listTemplates(elder, workspaceId);
    const tiny = mine[0]!.items.find((item) => item.ruleKey === 'amount.tiny')!;
    expect(tiny.myOverride).toBeNull();
    expect(tiny.effective.source).toBe('family');
    expect(tiny.effective.active).toBe(true);
    // 覆盖表里也确实没有她的行 —— 继承靠引用，不靠复制
    expect(
      await prisma.followupTemplateOverride.count({
        where: { workspaceId, userId: elder.userId },
      }),
    ).toBe(0);
  });

  it('4. 追问建议直接使用家族话术', async () => {
    const recipe = await request(app)
      .post('/api/recipes')
      .set(auth(owner))
      .send({ workspaceId, title: '测试红烧肉' })
      .expect(201);
    recipeId = recipe.body.data.id;

    const result = await suggest(owner, recipeId, '先炒糖色，放一点点糖就行');
    const tiny = result.matches.find((match) => match.ruleId === 'amount.tiny');
    expect(tiny).toBeDefined();
    expect(tiny!.question).toContain('一点点');
    expect(tiny!.source).toBe('family');
    expect(result.fallbackQuestionTemplate).toContain('{原话}');
  });

  it('5. 个人覆盖：换成自己的问法，只影响自己', async () => {
    const myWording = '妈，"{原话}"到底是几克？说个数我好记下来';
    await request(app)
      .put(`/api/followup-template-items/${tinyAmountItemId}/override`)
      .set(auth(owner))
      .send({ customQuestion: myWording })
      .expect(200);

    // 我自己：建议里出现我的问法
    const mine = await suggest(owner, recipeId, '放一点点糖');
    const myTiny = mine.matches.find((match) => match.ruleId === 'amount.tiny')!;
    expect(myTiny.question).toBe('妈，"一点点"到底是几克？说个数我好记下来');
    expect(myTiny.source).toBe('override');

    // 家族文案本身没被动过
    const familyRow = await prisma.followupTemplateItem.findUnique({
      where: { id: tinyAmountItemId },
    });
    expect(familyRow!.questionTemplate).not.toBe(myWording);

    // 外婆（未覆盖）看到的还是家族原文
    const hers = await suggest(elder, recipeId, '放一点点糖');
    const herTiny = hers.matches.find((match) => match.ruleId === 'amount.tiny')!;
    expect(herTiny.source).toBe('family');
    expect(herTiny.question).not.toContain('到底是几克');
  });

  it('6. 家族文案更新后：未覆盖者自动跟上，已覆盖者保留自己的', async () => {
    await request(app)
      .patch(`/api/followup-template-items/${tinyAmountItemId}`)
      .set(auth(owner))
      .send({ questionTemplate: '这里"{原话}"，用厨房秤称一下是几克？' })
      .expect(200);

    const hers = await suggest(elder, recipeId, '放一点点糖');
    expect(hers.matches.find((m) => m.ruleId === 'amount.tiny')!.question).toBe(
      '这里"一点点"，用厨房秤称一下是几克？',
    );

    const mine = await suggest(owner, recipeId, '放一点点糖');
    expect(mine.matches.find((m) => m.ruleId === 'amount.tiny')!.question).toContain('到底是几克');
  });

  it('7. 临时停用：这条话术不再出现在我的建议里，恢复后回来', async () => {
    await request(app)
      .put(`/api/followup-template-items/${tinyAmountItemId}/override`)
      .set(auth(owner))
      .send({ disabled: true, note: '最近不想问用量' })
      .expect(200);

    const suppressed = await suggest(owner, recipeId, '放一点点糖');
    expect(suppressed.matches.find((m) => m.ruleId === 'amount.tiny')).toBeUndefined();

    // 停用只影响我自己
    const hers = await suggest(elder, recipeId, '放一点点糖');
    expect(hers.matches.find((m) => m.ruleId === 'amount.tiny')).toBeDefined();

    // 我的覆盖里同时留着自定义文案 —— 恢复时文案还在
    const mine = await listTemplates(owner, workspaceId);
    const tiny = mine[0]!.items.find((item) => item.ruleKey === 'amount.tiny')!;
    expect(tiny.myOverride!.disabledAt).not.toBeNull();
    expect(tiny.myOverride!.customQuestion).toContain('到底是几克');
    expect(tiny.effective.active).toBe(false);

    // 恢复
    await request(app)
      .put(`/api/followup-template-items/${tinyAmountItemId}/override`)
      .set(auth(owner))
      .send({ disabled: false })
      .expect(200);
    const restored = await suggest(owner, recipeId, '放一点点糖');
    expect(restored.matches.find((m) => m.ruleId === 'amount.tiny')).toBeDefined();
  });

  it('8. 家族级停用对全员生效，重新启用后恢复', async () => {
    await request(app)
      .patch(`/api/followup-template-items/${tinyAmountItemId}`)
      .set(auth(owner))
      .send({ enabled: false })
      .expect(200);

    for (const session of [owner, elder]) {
      const result = await suggest(session, recipeId, '放一点点糖');
      expect(result.matches.find((m) => m.ruleId === 'amount.tiny')).toBeUndefined();
    }

    await request(app)
      .patch(`/api/followup-template-items/${tinyAmountItemId}`)
      .set(auth(owner))
      .send({ enabled: true })
      .expect(200);
    const result = await suggest(elder, recipeId, '放一点点糖');
    expect(result.matches.find((m) => m.ruleId === 'amount.tiny')).toBeDefined();
  });

  it('9. 自定义触发词条目：转写里出现触发词时给出这条话术', async () => {
    const create = await request(app)
      .post(`/api/workspaces/${workspaceId}/followup-templates`)
      .set(auth(owner))
      .send({ name: '外婆专属补充' })
      .expect(201);
    const templateId = create.body.data.id as string;

    await request(app)
      .post(`/api/workspaces/${workspaceId}/followup-templates/${templateId}/items`)
      .set(auth(owner))
      .send({
        category: 'other',
        triggerText: '老汤',
        questionTemplate: '您说的"{原话}"是上次留下来的那罐吗？大概多少？',
      })
      .expect(201);

    const result = await suggest(owner, recipeId, '然后加一勺老汤进去');
    const custom = result.matches.find((match) => match.ruleId.startsWith('custom:'));
    expect(custom).toBeDefined();
    expect(custom!.question).toBe('您说的"老汤"是上次留下来的那罐吗？大概多少？');
  });

  it('10. 兜底话术也是模板的一部分：可改写、可停用', async () => {
    const templates = await listTemplates(owner, workspaceId);
    const fallback = templates
      .flatMap((t) => t.items)
      .find((item) => item.ruleKey === FALLBACK_RULE_KEY)!;

    await request(app)
      .put(`/api/followup-template-items/${fallback.id}/override`)
      .set(auth(owner))
      .send({ customQuestion: '这句"{原话}"我没听明白，能换个说法吗？' })
      .expect(200);
    const mine = await suggest(owner, recipeId, '随便弄弄就行');
    expect(mine.fallbackQuestionTemplate).toBe('这句"{原话}"我没听明白，能换个说法吗？');

    await request(app)
      .put(`/api/followup-template-items/${fallback.id}/override`)
      .set(auth(owner))
      .send({ disabled: true })
      .expect(200);
    const suppressed = await suggest(owner, recipeId, '随便弄弄就行');
    expect(suppressed.fallbackQuestionTemplate).toBeNull();

    // 别人不受影响
    const hers = await suggest(elder, recipeId, '随便弄弄就行');
    expect(hers.fallbackQuestionTemplate).toContain('{原话}');
  });

  it('11. 清除覆盖后恢复完全继承', async () => {
    await request(app)
      .delete(`/api/followup-template-items/${tinyAmountItemId}/override`)
      .set(auth(owner))
      .expect(200);

    const mine = await listTemplates(owner, workspaceId);
    const tiny = mine[0]!.items.find((item) => item.ruleKey === 'amount.tiny')!;
    expect(tiny.myOverride).toBeNull();
    expect(tiny.effective.source).toBe('family');
    expect(
      await prisma.followupTemplateOverride.count({
        where: { itemId: tinyAmountItemId, userId: owner.userId },
      }),
    ).toBe(0);
  });

  it('12. 权限边界：贡献者能管自己的覆盖，不能动家族模板', async () => {
    // 贡献者改家族条目 → 403
    await request(app)
      .patch(`/api/followup-template-items/${tinyAmountItemId}`)
      .set(auth(elder))
      .send({ questionTemplate: '外婆想改家族文案' })
      .expect(403);
    await request(app)
      .post(`/api/workspaces/${workspaceId}/followup-templates`)
      .set(auth(elder))
      .send({ name: '外婆私建模板' })
      .expect(403);
    await request(app)
      .delete(`/api/followup-template-items/${tinyAmountItemId}`)
      .set(auth(elder))
      .expect(403);

    // 但设置自己的覆盖是允许的
    await request(app)
      .put(`/api/followup-template-items/${tinyAmountItemId}/override`)
      .set(auth(elder))
      .send({ customQuestion: '闺女啊，"{原话}"你就说是几克嘛' })
      .expect(200);
    const hers = await suggest(elder, recipeId, '放一点点糖');
    expect(hers.matches.find((m) => m.ruleId === 'amount.tiny')!.question).toContain('闺女啊');
  });

  it('13. 跨空间：别的家庭的话术条目，看不了也改不了', async () => {
    const otherWorkspace = await createWorkspace(outsider, '老王家');
    const otherTemplates = await listTemplates(outsider, otherWorkspace);
    const otherItem = otherTemplates[0]!.items[0]!;

    // 我拿着别人家条目的 id：覆盖、修改、删除都必须被拒
    await request(app)
      .put(`/api/followup-template-items/${otherItem.id}/override`)
      .set(auth(owner))
      .send({ customQuestion: '越权改写' })
      .expect(403);
    await request(app)
      .patch(`/api/followup-template-items/${otherItem.id}`)
      .set(auth(owner))
      .send({ enabled: false })
      .expect(403);
    await request(app)
      .delete(`/api/followup-template-items/${otherItem.id}`)
      .set(auth(owner))
      .expect(403);

    // 模板 id 也不能跨空间混用：把 A 空间的条目加到 B 空间的模板路径下
    await request(app)
      .post(`/api/workspaces/${workspaceId}/followup-templates/${otherTemplates[0]!.id}/items`)
      .set(auth(owner))
      .send({ category: 'other', triggerText: '越权', questionTemplate: '越权话术' })
      .expect(404);
  });

  it('14. 覆盖行跟着条目走：删掉家族条目，个人覆盖一并清理', async () => {
    const create = await request(app)
      .post(`/api/workspaces/${workspaceId}/followup-templates`)
      .set(auth(owner))
      .send({ name: '临时模板' })
      .expect(201);
    const item = await request(app)
      .post(`/api/workspaces/${workspaceId}/followup-templates/${create.body.data.id}/items`)
      .set(auth(owner))
      .send({ category: 'other', triggerText: '秘制', questionTemplate: '秘制是啥？' })
      .expect(201);
    const itemId = item.body.data.id as string;

    await request(app)
      .put(`/api/followup-template-items/${itemId}/override`)
      .set(auth(elder))
      .send({ disabled: true })
      .expect(200);
    expect(await prisma.followupTemplateOverride.count({ where: { itemId } })).toBe(1);

    await request(app)
      .delete(`/api/followup-template-items/${itemId}`)
      .set(auth(owner))
      .expect(200);
    expect(await prisma.followupTemplateOverride.count({ where: { itemId } })).toBe(0);
  });
});
