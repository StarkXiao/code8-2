import type { VagueCategory } from './enums';
import { NORMALIZATION_RULES, fallbackQuestion, matchVaguePhrases, renderQuestionTemplate } from './rules';

/**
 * 追问话术模板 —— 继承与覆盖的纯函数核心。
 *
 * 模型：
 *   家族模板（FollowupTemplate + Item）是空间级资产；
 *   个人覆盖（Override）稀疏存储"我和家族不一样"的部分：
 *     - customQuestion：把这条话术换成自己的问法；
 *     - disabledAt：临时停用这条（清空即恢复）。
 *
 * 新人加入时不需要写入任何数据 —— 没有覆盖行就完整继承家族模板。
 * 这也意味着家族文案更新后，所有没覆盖过的人自动看到新版本。
 */

/** 兜底话术的伪 ruleKey：没有命中任何内置规则时使用的问法 */
export const FALLBACK_RULE_KEY = 'fallback.any';

/** 每个空间自动播种的默认模板名 */
export const DEFAULT_TEMPLATE_NAME = '家族默认话术';

/** 数据库行的最小形状（服务端 Prisma 行、测试夹具都满足） */
export interface FollowupTemplateItemLike {
  id: string;
  ruleKey: string | null;
  category: VagueCategory;
  triggerText: string | null;
  questionTemplate: string;
  sortOrder: number;
  enabled: boolean;
}

export interface FollowupOverrideLike {
  itemId: string;
  customQuestion: string | null;
  disabledAt: Date | string | null;
}

export type FollowupSource = 'family' | 'override';

/** 一条话术对"我"的解析结果 */
export interface ResolvedFollowupItem {
  itemId: string;
  ruleKey: string | null;
  category: VagueCategory;
  triggerText: string | null;
  /** 应用个人覆盖后的生效文案 */
  questionTemplate: string;
  /** 生效文案来自家族还是我的改写 */
  source: FollowupSource;
  /** false = 家族停用或我临时停用，不再出现在建议里 */
  active: boolean;
  sortOrder: number;
}

/**
 * 把家族条目与个人覆盖合并成"我看到的生效话术"。
 * 家族停用的条目对个人覆盖也是终局 —— 个人无法复活一条家族级停用的话术。
 */
export function resolveEffectiveFollowupItems(
  items: FollowupTemplateItemLike[],
  myOverrides: FollowupOverrideLike[],
): ResolvedFollowupItem[] {
  const overrideByItem = new Map(myOverrides.map((override) => [override.itemId, override]));

  return items
    .map((item) => {
      const override = overrideByItem.get(item.id);
      const custom = override?.customQuestion?.trim() ? override.customQuestion.trim() : null;
      return {
        itemId: item.id,
        ruleKey: item.ruleKey,
        category: item.category,
        triggerText: item.triggerText,
        questionTemplate: custom ?? item.questionTemplate,
        source: (custom ? 'override' : 'family') as FollowupSource,
        active: item.enabled && !override?.disabledAt,
        sortOrder: item.sortOrder,
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.itemId.localeCompare(b.itemId));
}

/** 播种默认模板用的条目：内置规则的问法 + 一条兜底话术 */
export function defaultFollowupTemplateItems(): {
  ruleKey: string | null;
  category: VagueCategory;
  triggerText: string | null;
  questionTemplate: string;
  sortOrder: number;
}[] {
  const fromRules = NORMALIZATION_RULES.map((rule, index) => ({
    ruleKey: rule.id,
    category: rule.category,
    triggerText: null,
    questionTemplate: rule.question,
    sortOrder: index,
  }));
  return [
    ...fromRules,
    {
      ruleKey: FALLBACK_RULE_KEY,
      category: 'other' as VagueCategory,
      triggerText: null,
      questionTemplate: '这一步"{原话}"我有点拿不准，能再说详细一点吗？（可以直接按住说话）',
      sortOrder: fromRules.length,
    },
  ];
}

export interface FollowupSuggestion {
  /** 内置规则 id，或自定义条目的 `custom:<itemId>` */
  ruleId: string;
  category: VagueCategory;
  matchedPattern: string;
  suggestion: string;
  question: string;
  defaultConfidence: 'estimated' | 'assumed';
  /** 问法来源：家族模板 / 我的覆盖 / 内置规则兜底（模板缺这条规则时） */
  source: FollowupSource | 'builtin';
  /** 对应的模板条目 id（内置兜底时没有） */
  itemId: string | null;
}

/**
 * 对一段转写文本给出追问建议。
 *
 * 优先级：
 *   1. 内置规则命中 → 用生效话术渲染（被停用的条目会抑制这条建议）；
 *   2. 模板里还没有这条规则的条目（比如旧模板遇上新规则）→ 回退内置问法；
 *   3. 自定义触发词命中 → 追加建议；
 * 规则引擎只负责"哪句说不清"，话术模板只负责"怎么问"，两者在这里汇合。
 */
export function suggestFollowupQuestions(
  text: string,
  resolvedItems: ResolvedFollowupItem[],
): { matches: FollowupSuggestion[]; fallbackQuestionTemplate: string | null } {
  const byRuleKey = new Map<string, ResolvedFollowupItem>();
  const customItems: ResolvedFollowupItem[] = [];
  for (const item of resolvedItems) {
    if (item.ruleKey) byRuleKey.set(item.ruleKey, item);
    else customItems.push(item);
  }

  const matches: FollowupSuggestion[] = [];

  for (const match of matchVaguePhrases(text)) {
    const templated = byRuleKey.get(match.ruleId);
    if (templated) {
      // 这条话术被（家族或我）停用：不再出现在建议里
      if (!templated.active) continue;
      matches.push({
        ruleId: match.ruleId,
        category: match.category,
        matchedPattern: match.matchedPattern,
        suggestion: match.suggestion,
        question: renderQuestionTemplate(templated.questionTemplate, match.matchedPattern),
        defaultConfidence: match.defaultConfidence,
        source: templated.source,
        itemId: templated.itemId,
      });
    } else {
      // 模板缺这条规则（例如老空间遇上新增的内置规则）：回退内置问法
      matches.push({
        ruleId: match.ruleId,
        category: match.category,
        matchedPattern: match.matchedPattern,
        suggestion: match.suggestion,
        question: renderQuestionTemplate(match.question, match.matchedPattern),
        defaultConfidence: match.defaultConfidence,
        source: 'builtin',
        itemId: null,
      });
    }
  }

  // 自定义条目：按触发词命中，避免与内置规则重复报同一处
  const seenPatterns = new Set(matches.map((match) => match.matchedPattern));
  for (const item of customItems) {
    const trigger = item.triggerText?.trim();
    if (!item.active || !trigger) continue;
    if (!text.includes(trigger) || seenPatterns.has(trigger)) continue;
    seenPatterns.add(trigger);
    matches.push({
      ruleId: `custom:${item.itemId}`,
      category: item.category,
      matchedPattern: trigger,
      suggestion: '',
      question: renderQuestionTemplate(item.questionTemplate, trigger),
      defaultConfidence: 'assumed',
      source: item.source,
      itemId: item.itemId,
    });
  }

  // 兜底话术同样走模板：家族可以改写它；被停用时返回 null（抑制，而不是悄悄回退内置文案）
  const fallbackItem = byRuleKey.get(FALLBACK_RULE_KEY);
  const fallbackQuestionTemplate = !fallbackItem
    ? fallbackQuestion('{原话}')
    : fallbackItem.active
      ? fallbackItem.questionTemplate
      : null;

  return { matches, fallbackQuestionTemplate };
}
