import type {
  AccountKind,
  BotPreset,
  BotSettings,
  MemoryType,
} from "./types.js";
export const MEMORY_CATALOG = [
  ["fact", "事实", "#60a5fa"],
  ["preference", "偏好", "#f472b6"],
  ["profile", "画像", "#a78bfa"],
  ["project", "项目", "#34d399"],
  ["decision", "决策", "#fbbf24"],
  ["lesson", "经验", "#fb923c"],
  ["task", "任务", "#22d3ee"],
  ["person", "人物", "#67e8f9"],
  ["concept", "概念", "#c4b5fd"],
  ["persona", "人设", "#fda4af"],
].map(([key, label, color], i) => ({
  key: key as MemoryType,
  label: label!,
  name: label!,
  color: color!,
  kinds: (i < 7 ? ["standard", "qqbot"] : ["qqbot"]) as AccountKind[],
}));
export const STANDARD_LINK_CATALOG = [
  ["related_to", "相关"],
  ["supports", "支持"],
  ["contradicts", "矛盾"],
  ["supersedes", "替代"],
].map(([key, label]) => ({
  key: key!,
  label: label!,
  name: label!,
  directed: key !== "related_to",
}));
export const QQBOT_LINK_CATALOG = [
  ...STANDARD_LINK_CATALOG,
  ...[
    ["responsible_for", "负责"],
    ["belongs_to", "属于"],
    ["knows", "认识"],
    ["embodies", "体现人设"],
    ["participates_in", "参与"],
    ["likes", "喜欢"],
  ].map(([key, label]) => ({
    key: key!,
    label: label!,
    name: label!,
    directed: true,
  })),
];
export function capabilities(kind: AccountKind) {
  return {
    memory_types: MEMORY_CATALOG.filter((t) => t.kinds.includes(kind)).map(
      (t) => t.key,
    ),
    link_types: (kind === "qqbot"
      ? QQBOT_LINK_CATALOG
      : STANDARD_LINK_CATALOG
    ).map((t) => t.key),
    custom_links: kind === "qqbot",
    bootstrap: kind === "qqbot",
  };
}
const base: BotSettings = {
  bot_name: "小助手",
  identity: "提供信息与日常协助的机器人",
  personality: "友善、尊重事实",
  tone: "自然",
  language: "中文",
  answer_length: "简洁",
  emoji_level: "少量",
  proactivity: "适度",
  allow_rules: ["帮助整理信息"],
  deny_rules: ["不冒充真人", "不编造事实"],
  sensitive_topics: [],
  refusal_message: "这件事我无法协助，可以一起寻找合适的替代方式。",
  privacy_rules: ["不泄露私聊或个人隐私"],
  tool_rules: ["敏感操作先确认"],
  group_policy: "被提及时回应，避免刷屏",
  private_policy: "尊重用户意愿",
  search_types: MEMORY_CATALOG.map(t=>t.key),
  token_budget: 1200,
};
export const BOT_PRESETS: BotPreset[] = [
  [
    "gentle",
    "温柔陪伴",
    "温和、耐心、少打扰",
    "不做医疗或法律诊断，不替用户做高风险决定",
  ],
  [
    "lively",
    "活泼群友",
    "轻松、简短、适度幽默",
    "不刷屏，不攻击群友，不泄露私聊信息",
  ],
  [
    "rigorous",
    "严谨助手",
    "清晰、证据优先、结构化回答",
    "不确定时说明，不编造来源，工具操作先确认",
  ],
  [
    "support",
    "专业客服",
    "礼貌、稳定、任务导向",
    "不越权承诺，不收集无关隐私，敏感操作转人工",
  ],
  ["custom", "空白自定义", "可编辑的最小模板", "尊重隐私与用户自主决定"],
].map(([id, name, personality, boundary]) => ({
  id: id!,
  name: name!,
  description: personality!,
  settings: {
    ...structuredClone(base),
    personality: personality!,
    deny_rules: [...base.deny_rules, boundary!],
  },
  persona: {
    title: name!,
    content:
      name +
      "：" +
      personality +
      "。" +
      boundary +
      "。当前用户的明确要求优先，历史记忆仅作为参考。",
    keywords: ["人设", id!],
    importance: 80,
  },
  examples: [
    {
      type: "person",
      title: "示例联系人",
      content: "示例联系人小林喜欢简洁的回答。",
      keywords: ["示例"],
    },
    {
      type: "concept",
      title: "示例概念",
      content: "示例项目讨论以可验证事实为依据。",
      keywords: ["示例"],
    },
  ],
}));
