export type PromptSkillId =
  | "evidence-first-analysis"
  | "original-text-fidelity"
  | "speech-ordering"
  | "scene-evidence"
  | "cinematic-image-quality"
  | "visual-safety"
  | "reliability-repair";

export type PromptSkillStage = "analysis" | "storyboard" | "repair";

interface PromptSkill {
  id: PromptSkillId;
  title: string;
  purpose: string;
  rules: string[];
  avoid?: string[];
}

const PROMPT_SKILLS: Record<PromptSkillId, PromptSkill> = {
  "evidence-first-analysis": {
    id: "evidence-first-analysis",
    title: "证据优先理解",
    purpose: "只提取能被当前原文支持的人物、场景、事件和连续性信息。",
    rules: [
      "人物、场景、关键事件、情绪节奏和连续性提示必须来自当前段原文。",
      "能提供 evidence 时，quote 必须是原文中的短句或词组。",
      "visualAnchor 只能证明道具、氛围或可见元素，不能单独证明具体地点。",
      "没有原文证据的人物关系、场景名称、外貌服装、道具和全局连续性不要输出。"
    ],
    avoid: [
      "不要因为项链、照片、灯光等道具词自动推断顶层公寓、医院或其他地点。",
      "不要把标题词、物种词、等级词当成人物。"
    ]
  },
  "original-text-fidelity": {
    id: "original-text-fidelity",
    title: "原文保真",
    purpose: "保证解说剧阅读内容和原文完全一致。",
    rules: [
      "sourceText、anchorSentence、narration、dialogueLines.text 必须保留原文语言和原文表述。",
      "prompt 的 [台词/旁白] 行中双引号内的旁白和对白必须保留原文，不翻译、不删减、不净化。",
      "安全画面化只允许改视觉字段，不允许改阅读字段。",
      "模型不得续写未提供剧情，也不得合并跨越不同【分镜单元】的原文字段。"
    ],
    avoid: [
      "不要为了安全或画面更顺，把原文旁白改写成概述。",
      "不要删除 said/asked 等归属语；归属语属于旁白阅读内容。"
    ]
  },
  "speech-ordering": {
    id: "speech-ordering",
    title: "对白旁白顺序",
    purpose: "让每一句解说剧阅读顺序严格跟随原文。",
    rules: [
      "引号内直接发言必须进入 dialogueLines，不能混入 narration。",
      "英文 `\"对白,\" Elena said.` 输出顺序必须是 Elena 对白，再停顿，再旁白 `Elena said.`。",
      "角色对白切到旁白时插入停顿；旁白切到角色对白时也插入停顿。",
      "speaker 必须写完整人物称谓；无法判断时写未指明说话者，不使用 he/she/it/they 或 他/她/它。"
    ],
    avoid: [
      "不要把 `Elena said` 提到对白前面读。",
      "不要把只有引号的对白降级成旁白。"
    ]
  },
  "scene-evidence": {
    id: "scene-evidence",
    title: "场景证据",
    purpose: "让每个画面场景来自当前文本、相邻锚点或已验证理解档案。",
    rules: [
      "具体场景必须有当前分镜单元、相邻段锚点、相邻镜头或已验证理解档案支撑。",
      "开头世界观、血脉规则、等级规则缺场景时，只能继承附近原文明确出现的强场景锚点。",
      "`世界观建立画面`、`当前连续场景`、`前世记忆画面` 不能作为最终可拍场景核心。",
      "人物名证据和场景证据分离；不要用下一句或附近场景锚点里的人名证明当前镜头人物。"
    ],
    avoid: [
      "不要把 previous life / past life / Pact Backlash 单独当作场景切换。",
      "不要只凭道具、氛围词或视觉风格幻想具体地点。"
    ]
  },
  "cinematic-image-quality": {
    id: "cinematic-image-quality",
    title: "画面质量",
    purpose: "把每个分镜单元写成可拍、可生成、空间关系清楚的画面。",
    rules: [
      "[画面细节] 必须包含明确主体、可见动作或状态、空间层次、关键道具和当前场景光源。",
      "近景、特写、面部或细节镜头重点补嘴角、眼部、面部状态和视线方向。",
      "中景、全景、远景、全身、半身或多人同框优先写动作路径、人物站位、距离关系、身体朝向和手部动作。",
      "镜头语法必须写清景别、焦距、焦点状态、景深或虚化；不要固定单一 35mm 模板。"
    ],
    avoid: [
      "不要写 `画面主体`、`当前叙事重点`、`关键道具` 这类无具体对象的占位词。",
      "不要把完整原文机械贴进 [画面细节]。"
    ]
  },
  "visual-safety": {
    id: "visual-safety",
    title: "安全画面化",
    purpose: "高风险情节只做克制、非具象的影视表达，同时不改变阅读原文。",
    rules: [
      "画面、镜头、声音和导演批注采用克制、非具象、非操作性的表达，避免细节化呈现令人不适或可能引导模仿的内容。",
      "优先呈现结果、环境变化、道具状态、人物反应、遮挡、剪影、远景或转场空镜，不展开过程。",
      "亲密、冲突或边界紧张的场面，聚焦人物站位、距离、视线、衣着和环境，不写身体细节。",
      "安全画面化只约束视觉表达，不得提供可执行步骤，也不得影响 [台词/旁白] 阅读行。"
    ],
    avoid: [
      "不要突破平台内容规范，不要输出鼓励模仿或可执行的高风险行为细节。",
      "不要用安全改写替换 narration 或 dialogueLines.text。"
    ]
  },
  "reliability-repair": {
    id: "reliability-repair",
    title: "可靠性修复",
    purpose: "发现模型漏镜头、泛场景、无证据人物或薄弱画面时进行局部或整镜头修复。",
    rules: [
      "模型漏掉的分镜单元必须补齐镜头，且 [导演批注] 标记保底修复镜头。",
      "无证据具体场景、医院/手术台、空白背景、标题词误识别触发整镜头可靠性重写。",
      "无证据额外人物、泛称人物或单独医护人员优先局部清洗，保留原镜头可用动作、光源和构图。",
      "修复只能改视觉字段和提示词结构，不能改 sourceText、narration、dialogueLines.text 或 [台词/旁白] 阅读行。"
    ],
    avoid: [
      "不要因为 scene=未明确场景 就整条替换可用画面。",
      "不要让可靠性修复镜头泛滥成全部镜头。"
    ]
  }
};

export const ANALYSIS_PROMPT_SKILLS: PromptSkillId[] = [
  "evidence-first-analysis"
];

export const STORYBOARD_PROMPT_SKILLS: PromptSkillId[] = [
  "original-text-fidelity",
  "speech-ordering",
  "scene-evidence",
  "cinematic-image-quality",
  "visual-safety"
];

export function renderPromptSkillSet(stage: PromptSkillStage, skillIds: PromptSkillId[]): string {
  return [
    `Prompt Skill Set: ${stage}`,
    ...skillIds.map((skillId) => renderPromptSkill(PROMPT_SKILLS[skillId]))
  ].join("\n\n");
}

function renderPromptSkill(skill: PromptSkill): string {
  return [
    `Prompt Skill: ${skill.id}`,
    `名称：${skill.title}`,
    `用途：${skill.purpose}`,
    "硬规则：",
    ...skill.rules.map((rule, index) => `${index + 1}. ${rule}`),
    ...(skill.avoid?.length
      ? [
        "禁止：",
        ...skill.avoid.map((rule, index) => `${index + 1}. ${rule}`)
      ]
      : [])
  ].join("\n");
}
