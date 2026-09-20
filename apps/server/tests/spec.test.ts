import { describe, expect, it } from 'vitest';
import {
  formatSpecSummary,
  hasUnfilledPlaceholder,
  matchVaguePhrases,
  renderQuestionTemplate,
  renderQuestionText,
  validateResolvedSpec,
  type ResolvedSpec,
} from '@froa/shared';

const base = {
  evidence: { clipId: 'clip_1' },
  confidence: 'confirmed',
} as const;

describe('可复做规格校验器', () => {
  it('用量类必须有数值或区间，且必须带单位', () => {
    expect(validateResolvedSpec({ ...base, type: 'amount', value: 3, unit: 'g' })).toHaveLength(0);

    const noUnit = validateResolvedSpec({ ...base, type: 'amount', value: 3 });
    expect(noUnit.map((i) => i.field)).toContain('unit');

    const noValue = validateResolvedSpec({ ...base, type: 'amount', unit: 'g' });
    expect(noValue.map((i) => i.field)).toContain('value');
  });

  it('火候类必须写可观察的判断标准', () => {
    const missing = validateResolvedSpec({ ...base, type: 'heat' });
    expect(missing.map((i) => i.field)).toContain('criterion');

    const ok = validateResolvedSpec({
      ...base,
      type: 'heat',
      criterion: '糖全部化开、变成枣红色、闻到焦糖香',
    });
    expect(ok).toHaveLength(0);
  });

  it('手感类必须写手感描述与对照物', () => {
    expect(validateResolvedSpec({ ...base, type: 'feel' }).map((i) => i.field)).toContain('criterion');
  });

  it('时间类可以只给判断标准', () => {
    expect(validateResolvedSpec({ ...base, type: 'time', criterion: '筷子能轻松插透' })).toHaveLength(0);
  });

  it('区间上下限颠倒要报错', () => {
    const issues = validateResolvedSpec({
      ...base,
      type: 'amount',
      unit: 'g',
      range: { min: 10, max: 2 },
    });
    expect(issues.map((i) => i.field)).toContain('range');
  });

  it('没有任何证据来源时拒绝通过 —— 结论必须可追溯', () => {
    const issues = validateResolvedSpec({
      type: 'amount',
      value: 3,
      unit: 'g',
      confidence: 'confirmed',
      evidence: {},
    });
    expect(issues.map((i) => i.field)).toContain('evidence');
  });
});

describe('模糊描述规则库', () => {
  it('能识别火候 / 手感 / 用量 / 时间四类模糊表述', () => {
    const matches = matchVaguePhrases('中火炒到收汁，揉到不粘手，放一点糖，焖一会儿');
    const categories = new Set(matches.map((m) => m.category));

    expect(categories.has('heat')).toBe(true);
    expect(categories.has('feel')).toBe(true);
    expect(categories.has('amount')).toBe(true);
    expect(categories.has('time')).toBe(true);
  });

  it('同一规则不会重复命中', () => {
    const matches = matchVaguePhrases('一点，一点，再一点');
    const ids = matches.map((m) => m.ruleId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('普通文本不应产生误报', () => {
    expect(matchVaguePhrases('把肉切成三厘米见方的块')).toHaveLength(0);
  });

  it('追问模板会替换原话占位符', () => {
    const question = renderQuestionTemplate('您说"{原话}"，大概几克？', '一点糖');
    expect(question).toContain('一点糖');
    expect(question).not.toContain('{原话}');
  });
});

describe('规格摘要', () => {
  it('把结构化结论渲染成人能读懂的一句话', () => {
    const spec: ResolvedSpec = {
      type: 'amount',
      value: 4,
      unit: 'g',
      reference: '白瓷勺半勺',
      confidence: 'estimated',
      evidence: { clipId: 'clip_1' },
    };
    expect(formatSpecSummary(spec)).toContain('4g');
    expect(formatSpecSummary(spec)).toContain('白瓷勺半勺');
    expect(formatSpecSummary(null)).toBe('未整理');
  });
});

describe('追问话术渲染', () => {
  const template = '{称呼}，您说"{原话}"，大概是几克呀？';

  it('同时替换原话与称呼', () => {
    const text = renderQuestionText(template, { rawPhrase: '放一点糖', displayName: '外婆' });
    expect(text).toBe('外婆，您说"放一点糖"，大概是几克呀？');
    expect(hasUnfilledPlaceholder(text)).toBe(false);
  });

  it('没有称呼时清掉占位符与多余标点，句子不能以逗号开头', () => {
    const text = renderQuestionText(template, { rawPhrase: '放一点糖' });
    expect(text).toBe('您说"放一点糖"，大概是几克呀？');
    expect(text.startsWith('，')).toBe(false);
    expect(hasUnfilledPlaceholder(text)).toBe(false);
  });

  it('没有原话时保留占位符，提示使用者这句话会被替换', () => {
    const text = renderQuestionText(template, { displayName: '外婆' });
    expect(text).toContain('{原话}');
    expect(hasUnfilledPlaceholder(text)).toBe(true);
  });

  it('兼容旧的单占位符渲染器', () => {
    expect(renderQuestionTemplate('您说"{原话}"？', '少许')).toContain('少许');
  });
});
