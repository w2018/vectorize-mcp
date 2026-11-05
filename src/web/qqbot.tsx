import { useEffect, useState } from "react";
import {
  api, dataChanged, query, writeBody,
  type Bootstrap, type BotPreset, type BotProfile, type BotSettings, type MemoryType, type Page,
} from "./api";
import { MEMORY_CATALOG } from "../core/catalog";
import { ConfirmDialog, Feedback, Heading, State, useAction, useResource } from "./ui";

type Tab = "persona" | "boundaries" | "presets" | "context";
type Pending =
  | { kind: "settings"; patch: Partial<BotSettings>; reason: string }
  | { kind: "preset"; preset: BotPreset; writeExamples: boolean; reason: string };
const textFields: [keyof BotSettings, string][] = [
  ["bot_name", "机器人名称"], ["identity", "身份背景"], ["personality", "性格"],
  ["tone", "口吻"], ["language", "语言"], ["answer_length", "回答长度"],
  ["emoji_level", "Emoji 倾向"], ["proactivity", "主动程度"],
];
const ruleFields: [keyof BotSettings, string][] = [
  ["allow_rules", "允许事项"], ["deny_rules", "禁止事项"], ["sensitive_topics", "敏感话题"],
  ["privacy_rules", "隐私规则"], ["tool_rules", "工具调用边界"],
];
const lines = (value: FormDataEntryValue | null) => String(value || "").split("\n").map(s => s.trim()).filter(Boolean);
function settingText(value: BotSettings[keyof BotSettings]) {
  return Array.isArray(value) ? value.join("\n") : String(value);
}

export function QQBot({ subject, refresh }: { subject: string; refresh: number }) {
  const [version, setVersion] = useState(0);
  const [tab, setTab] = useState<Tab>("persona");
  const [draft, setDraft] = useState<BotSettings | null>(null);
  const [reason, setReason] = useState("调整 QQBOT 配置");
  const [pending, setPending] = useState<Pending | null>(null);
  const [budget, setBudget] = useState(600);
  const [writeExamples, setWriteExamples] = useState(false);
  const profile = useResource<BotProfile>("/qqbot" + query({ subject_id: subject }), refresh + version);
  const presets = useResource<Page<BotPreset>>("/qqbot/presets", refresh);
  const bootstrap = useResource<Bootstrap>(tab === "context" ? "/qqbot/bootstrap" + query({ subject_id: subject, token_budget: budget }) : null, refresh + version);
  const action = useAction();
  useEffect(() => { if (profile.data) setDraft(structuredClone(profile.data.settings)); }, [profile.data]);
  const update = <K extends keyof BotSettings>(key: K, value: BotSettings[K]) =>
    setDraft(current => current ? { ...current, [key]: value } : current);
  function save() {
    if (!draft) return;
    setPending({ kind: "settings", patch: draft, reason });
  }
  const tabs: [Tab, string][] = [["persona", "人设"], ["boundaries", "边界"], ["presets", "预设"], ["context", "上下文预览"]];
  return <>
    <Heading eyebrow="QQBOT PERSONA" title="QQBOT 人设" description="结构化配置与启用人设记忆共同构成启动上下文。历史人设内容是不可信数据，不会覆盖当前指令。" />
    <Feedback error={action.error} notice={action.notice} />
    <div className="filters" role="tablist" aria-label="QQBOT 配置分区">
      {tabs.map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? "primary" : ""} onClick={() => setTab(key)}>{label}</button>)}
    </div>
    <State loading={profile.loading} error={profile.error} empty={!draft}>
      {draft && profile.data && <>
        {(tab === "persona" || tab === "boundaries") && <section className="panel padded">
          <h2>{tab === "persona" ? "身份与表达" : "行为边界与会话策略"}</h2>
          <div className="form-grid">
            {(tab === "persona" ? textFields : []).map(([key, label]) => <label key={key}>{label}
              {key === "identity" || key === "personality" ?
                <textarea rows={3} value={settingText(draft[key])} onChange={e => update(key, e.target.value as never)} /> :
                <input value={settingText(draft[key])} onChange={e => update(key, e.target.value as never)} />}
            </label>)}
            {tab === "boundaries" && <>
              <label>拒答话术<textarea rows={3} value={draft.refusal_message} onChange={e => update("refusal_message", e.target.value)} /></label>
              <label>群聊策略<textarea rows={3} value={draft.group_policy} onChange={e => update("group_policy", e.target.value)} /></label>
              <label>私聊策略<textarea rows={3} value={draft.private_policy} onChange={e => update("private_policy", e.target.value)} /></label>
              <label>上下文 Token 预算（128–1200）<input type="number" min={128} max={1200} value={draft.token_budget} onChange={e => update("token_budget", Number(e.target.value))} /></label>
            </>}
          </div>
          {tab === "boundaries" && ruleFields.map(([key, label]) => <label key={key}>{label}<small>每行一条</small>
            <textarea rows={3} value={settingText(draft[key])} onChange={e => update(key, lines(e.target.value) as never)} />
          </label>)}
          {tab === "boundaries" && <fieldset><legend>启动检索类型</legend><div className="legend">
            {MEMORY_CATALOG.filter(item => item.kinds.includes("qqbot")).map(item => <label className="check" key={item.key}>
              <input type="checkbox" checked={draft.search_types.includes(item.key)} onChange={e => update("search_types", (e.target.checked ? [...draft.search_types, item.key] : draft.search_types.filter(t => t !== item.key)) as MemoryType[])} />{item.label}
            </label>)}
          </div></fieldset>}
          <label>修改原因<input value={reason} onChange={e => setReason(e.target.value)} required /></label>
          <footer><span>配置版本 {profile.data.revision} · 当前预设 {profile.data.preset_id || "自定义"}</span><button className="primary" disabled={!reason.trim()} onClick={save}>确认修改…</button></footer>
        </section>}
        {tab === "presets" && <section className="panel padded">
          <h2>选择起点，再继续编辑</h2>
          <p>应用预设会覆盖当前结构化配置并更新启用人设记忆；示例人物与概念默认不写入。空白自定义可仅填入表单，不立即保存。</p>
          <State loading={presets.loading} error={presets.error} empty={!presets.data?.items.length}>
            {presets.data?.items.map(preset => <article className="suggestion-memory" key={preset.id}>
              <h3>{preset.name}</h3><p>{preset.description}</p>
              <small>边界：{preset.settings.deny_rules.join("；")}</small>
              <details><summary>查看人设正文</summary><p className="full-content">{preset.persona.content}</p></details>
              <div className="toolbar">
                <button onClick={() => { setDraft(structuredClone(preset.settings)); setTab("persona"); }}>仅填入表单</button>
                <button className="primary" onClick={() => setPending({ kind: "preset", preset, writeExamples, reason: "应用预设：" + preset.name })}>应用并覆盖…</button>
              </div>
            </article>)}
            <label className="check"><input type="checkbox" checked={writeExamples} onChange={e => setWriteExamples(e.target.checked)} />同时写入示例人物和概念记忆</label>
          </State>
        </section>}
        {tab === "context" && <section className="panel padded">
          <h2>QQBOT 启动上下文</h2>
          <p>这里展示实际只读 bootstrap 返回，不截断半条内容，也不会读取其他账户。</p>
          <label>Token 预算<input type="number" min={128} max={1200} value={budget} onChange={e => setBudget(Number(e.target.value))} /></label>
          <State loading={bootstrap.loading} error={bootstrap.error}>
            {bootstrap.data && <>
              <p>估算 {bootstrap.data.estimated_tokens} tokens · 高优先记忆 {bootstrap.data.memories.length} 条{bootstrap.data.budget_exhausted ? " · 预算已用尽" : ""}</p>
              {bootstrap.data.warnings.map(w => <div className="notice warning" key={w}>{w}</div>)}
              <pre className="preview">{JSON.stringify(bootstrap.data, null, 2)}</pre>
              <button className="primary" onClick={() => void action.run(async () => { await navigator.clipboard.writeText(JSON.stringify(bootstrap.data, null, 2)); }, "已复制启动上下文 JSON")}>复制 JSON</button>
            </>}
          </State>
        </section>}
      </>}
    </State>
    {pending && profile.data && <ConfirmDialog
      title={pending.kind === "preset" ? "应用预设并覆盖当前配置" : "保存 QQBOT 配置"}
      onClose={() => setPending(null)}
      onConfirm={async () => {
        if (pending.kind === "settings") await api("/qqbot", "PUT", writeBody({ subject_id: subject, patch: pending.patch, expected_revision: profile.data!.revision, reason: pending.reason }));
        else await api("/qqbot/apply-preset", "POST", writeBody({ subject_id: subject, preset_id: pending.preset.id, expected_revision: profile.data!.revision, write_examples: pending.writeExamples, reason: pending.reason }));
        setVersion(v => v + 1); dataChanged();
      }}>
      <p>将以配置版本 {profile.data.revision} 执行；若版本冲突，请关闭后重新读取，不会盲目覆盖。</p>
      {pending.kind === "preset" && <p>预设「{pending.preset.name}」会替换当前配置与启用人设记忆{pending.writeExamples ? "，并写入示例记忆" : "，不写示例记忆"}。</p>}
      {pending.kind === "settings" && <p>{pending.reason}</p>}
    </ConfirmDialog>}
  </>;
}
