import type { VagueCategory } from './enums';
import { VAGUE_CATEGORIES } from './enums';

/**
 * 追问话术家族模板。
 *
 * 三级继承模型：
 *   家族模板（QuestionTemplate，全空间共享）
 *     └─ 成员个人设置（QuestionTemplateMemberSetting）
 *          ├─ 无记录      → 完全继承（新人加入时自动套用的就是这个状态）
 *          ├─ override    → 用自己的话术替换家族话术
 *          └─ disabled    → 这条暂时不对自己生效
 *
 * 家族模板可以整体停用（enabled=false），停用后新成员不会套用，
 * 所有成员的追问台都不再显示它。
 */

export const QUESTION_TEMPLATE_SETTING_MODES = ['override', 'disabled'] as const;
export type QuestionTemplateSettingMode = (typeof QUESTION_TEMPLATE_SETTING_MODES)[number];

/** 解析后成员实际看到的状态 */
export type EffectiveTemplateMode = 'inherited' | QuestionTemplateSettingMode;

/** 话术中允许出现的占位符 */
export const QUESTION_TEMPLATE_PLACEHOLDERS = ['{原话}', '{称呼}'] as const;

export interface QuestionTemplateDto {
  id: string;
  workspaceId: string;
  /** null = 通用兜底话术，任何分类下都出现 */
  category: VagueCategory | null;
  title: string;
  content: string;
  sortOrder: number;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionTemplateMemberSettingDto {
  id: string;
  templateId: string;
  userId: string;
  mode: QuestionTemplateSettingMode;
  contentOverride: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 成员视角下一条模板的最终形态。
 * 家族话术、个人设置合并之后的结果，前端拿到即可直接渲染。
 */
export interface EffectiveQuestionTemplate {
  templateId: string;
  category: VagueCategory | null;
  title: string;
  /** 家族原始话术（个人覆盖时仍要能看到"原本是怎么问的"） */
  familyContent: string;
  /** 最终生效的话术；disabled 时为 null */
  effectiveContent: string | null;
  mode: EffectiveTemplateMode;
  /** 停用时填写的原因 */
  reason: string | null;
  /** 家族模板是否整体启用 */
  familyEnabled: boolean;
}

/* ------------------------------------------------------------------ */
/* 家族默认话术                                                        */
/* ------------------------------------------------------------------ */

/**
 * 新建空间时写入的家族默认话术。
 * 内容与模糊描述规则库（rules.ts）的分类口径保持一致，
 * 但这里是"真正发给家人的话"，所以写得更口语、更像一家人说话。
 * 占位符：{原话}=待澄清的那句口述，{称呼}=被追问人的称呼。
 */
export interface DefaultQuestionTemplateSeed {
  category: VagueCategory | null;
  title: string;
  content: string;
}

export const DEFAULT_QUESTION_TEMPLATES: DefaultQuestionTemplateSeed[] = [
  {
    category: null,
    title: '通用：请对方再讲细一点',
    content: '这一步"{原话}"我有点拿不准，{称呼}方便的时候能再说详细一点吗？可以直接按住说话，我这边能听到原声。',
  },
  {
    category: null,
    title: '通用：确认我记下来的版本',
    content: '我把"{原话}"记成了：（此处填上你的理解）。{称呼}看我理解得对不对？哪里不对直接说，我改。',
  },
  {
    category: 'amount',
    title: '用量：换成克数',
    content: '{称呼}，您说"{原话}"，这个大概是几克呀？要是不好估，告诉我用您平时那只勺是几勺也行，我来换算。',
  },
  {
    category: 'amount',
    title: '用量：参照物换算法',
    content: '您说"{原话}"，是用家里那只白瓷勺量的吗？一平勺还是小半勺？我先把它换算成克，下次别人照着做就不会错了。',
  },
  {
    category: 'amount',
    title: '用量：抓一把有多大',
    content: '"{原话}"抓起来大概多大一把？{称呼}能和鸡蛋或者乒乓球比一下吗？我也好心里有数。',
  },
  {
    category: 'heat',
    title: '火候：火苗到哪一圈',
    content: '"{原话}"的时候，火苗大概到锅底哪一圈？锅里的油或者水是什么样子（冒小泡 / 微微冒烟 / 翻腾）？',
  },
  {
    category: 'heat',
    title: '火候：听到看到的信号',
    content: '{称呼}，"{原话}"那会儿锅里是什么声音、什么样子？大概持续多久就要进行下一步？',
  },
  {
    category: 'feel',
    title: '手感：找个东西对比',
    content: '"{原话}"摸起来是什么感觉？和什么东西最像，像耳垂、棉花还是橡皮泥？按下去会不会马上弹回来？',
  },
  {
    category: 'time',
    title: '时间：大概几分钟',
    content: '"{原话}"大概是几分钟呀？中间要不要盖盖子？火是大还是小？',
  },
  {
    category: 'time',
    title: '时间：怎么算好了',
    content: '{称呼}，"{原话}"的时候怎么判断可以了？用筷子戳一下是什么感觉？颜色或者汤汁变成什么样算好？',
  },
];

/** 校验分类值（外部输入不能直接写进 category 字段） */
export function isVagueCategory(value: unknown): value is VagueCategory {
  return typeof value === 'string' && (VAGUE_CATEGORIES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

export interface QuestionTemplateVars {
  /** 待澄清的那句原话 */
  rawPhrase?: string | null;
  /** 被追问人的称呼，未提供时把占位符清空成礼貌句式 */
  displayName?: string | null;
}

/**
 * 渲染话术：把 {原话} / {称呼} 替换成实际值。
 *
 * - {原话} 未提供时原样保留占位符，让填写的人一眼看到"这里会被替换"；
 * - {称呼} 未提供时替换成空串，并顺手清理多余的逗号和空格，
 *   句子读起来不应该出现"，方便的时候"这种开头。
 */
export function renderQuestionText(template: string, vars: QuestionTemplateVars = {}): string {
  let text = template.replace(/\{原话\}/g, vars.rawPhrase ?? '{原话}');
  if (vars.displayName) {
    text = text.replace(/\{称呼\}/g, vars.displayName);
  } else {
    text = text
      .replace(/\{称呼\}[，,、\s]*/g, '')
      .replace(/\{称呼\}/g, '');
  }
  return text.replace(/[ 　]{2,}/g, ' ').trim();
}

/** 话术里是否还包含未被替换的占位符 */
export function hasUnfilledPlaceholder(text: string): boolean {
  return /\{[^{}]+\}/.test(text);
}
