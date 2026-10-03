import { Hono } from "hono";
import { decryptText, encryptText } from "../lib/crypto";
import { fail, ok } from "../lib/response";
import { canRead, loadWorldAccess } from "../lib/world-access";
import { getUser, requireLogin, type AppVariables } from "../middleware/session";
import type { Env } from "../types";
import { extractBlockText } from "../lib/tiptap-links";

/** 支持的生成类型 */
const GENERATE_KINDS = new Set(["character", "location", "faction", "plot", "expand"]);

/** 每种生成类型的任务提示词 */
const KIND_PROMPTS: Record<string, string> = {
  character: "请创作一个人物设定，包含：姓名、身份地位、外貌特征、性格、背景故事、与他人的关系。",
  location: "请创作一个地点设定，包含：名称、地理风貌、气候、居民与风俗、历史沿革、隐藏的秘密。",
  faction: "请创作一个势力设定，包含：名称、宗旨、组织结构、领袖、资源与势力范围、敌对与盟友关系。",
  plot: "请设计一段剧情草案，包含：起因、发展、核心冲突、可能的转折与结局方向。",
  expand: "请扩写下面的内容：保持原有风格与设定一致，扩充细节与描写，篇幅约为原文的两倍。",
};

/** 记录一次 AI 调用（成功 / 失败） */
async function logAiUsage(
  db: D1Database,
  userId: string,
  worldId: string | null,
  kind: string,
  success: boolean,
): Promise<void> {
  await db
    .prepare("INSERT INTO ai_usage (id, user_id, world_id, kind, success, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, worldId, kind, success ? 1 : 0, Date.now())
    .run();
}

const aiRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/** 读取当前用户的 AI 配置（不返回密钥明文，只返回是否已配置） */
aiRoutes.get("/ai/settings", requireLogin, async (c) => {
  const user = getUser(c);
  const row = await c.env.DB.prepare(
    "SELECT provider, base_url, model, api_key_encrypted FROM user_ai_settings WHERE user_id = ?",
  )
    .bind(user.id)
    .first<{ provider: string; base_url: string; model: string; api_key_encrypted: string }>();

  return ok(c, {
    provider: row?.provider ?? "zhipu",
    baseUrl: row?.base_url ?? "",
    model: row?.model ?? "",
    hasKey: Boolean(row?.api_key_encrypted),
  });
});

/**
 * 保存 AI 配置。
 * body: { provider, baseUrl, model, apiKey? }——apiKey 为空时保留已存密钥。
 */
aiRoutes.put("/ai/settings", requireLogin, async (c) => {
  const user = getUser(c);

  let body: { provider?: unknown; baseUrl?: unknown; model?: unknown; apiKey?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }

  const provider = typeof body.provider === "string" ? body.provider.slice(0, 30) : "custom";
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim().replace(/\/+$/, "") : "";
  const model = typeof body.model === "string" ? body.model.trim().slice(0, 100) : "";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";

  if (!/^https?:\/\//.test(baseUrl)) {
    return fail(c, "Base URL 需以 http(s):// 开头");
  }
  if (!model) {
    return fail(c, "请填写模型名称");
  }
  if (!c.env.AI_KEY_SECRET) {
    return fail(c, "服务端未配置 AI_KEY_SECRET，无法保存密钥", 500);
  }

  const existing = await c.env.DB.prepare("SELECT api_key_encrypted FROM user_ai_settings WHERE user_id = ?")
    .bind(user.id)
    .first<{ api_key_encrypted: string }>();
  if (!apiKey && !existing) {
    return fail(c, "请填写 API Key");
  }

  const encrypted = apiKey ? await encryptText(c.env.AI_KEY_SECRET, apiKey) : existing?.api_key_encrypted ?? "";
  await c.env.DB.prepare(
    `INSERT INTO user_ai_settings (user_id, provider, base_url, model, api_key_encrypted, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET provider = ?, base_url = ?, model = ?, api_key_encrypted = ?, updated_at = ?`,
  )
    .bind(
      user.id,
      provider,
      baseUrl,
      model,
      encrypted,
      Date.now(),
      provider,
      baseUrl,
      model,
      encrypted,
      Date.now(),
    )
    .run();

  return ok(c, { saved: true });
});

/**
 * 生成内容（代理调用用户配置的 OpenAI 兼容接口）。
 * body: { worldId, entryId?, kind, instruction?, text? }
 * 生成结果由前端插入为草稿，不直接入库。
 */
aiRoutes.post("/ai/generate", requireLogin, async (c) => {
  const user = getUser(c);

  let body: { worldId?: unknown; entryId?: unknown; kind?: unknown; instruction?: unknown; text?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, "请求格式不正确");
  }

  const worldId = typeof body.worldId === "string" ? body.worldId : "";
  const entryId = typeof body.entryId === "string" ? body.entryId : null;
  const kind = typeof body.kind === "string" ? body.kind : "";
  const instruction = typeof body.instruction === "string" ? body.instruction.trim().slice(0, 500) : "";
  const selectedText = typeof body.text === "string" ? body.text.slice(0, 3000) : "";

  if (!GENERATE_KINDS.has(kind)) {
    return fail(c, "生成类型不正确");
  }
  if (kind === "expand" && !selectedText.trim()) {
    return fail(c, "扩写需要先选中一段文字");
  }

  const access = await loadWorldAccess(c.env.DB, worldId, user.id);
  if (!access || !canRead(access)) {
    return fail(c, "世界不存在或无权访问", 404);
  }

  // 读取用户 AI 配置
  const settings = await c.env.DB.prepare(
    "SELECT base_url, model, api_key_encrypted FROM user_ai_settings WHERE user_id = ?",
  )
    .bind(user.id)
    .first<{ base_url: string; model: string; api_key_encrypted: string }>();
  if (!settings) {
    return fail(c, "请先在个人设置中配置 AI 供应商与 API Key", 400);
  }
  if (!c.env.AI_KEY_SECRET) {
    return fail(c, "服务端未配置 AI_KEY_SECRET", 500);
  }
  const apiKey = await decryptText(c.env.AI_KEY_SECRET, settings.api_key_encrypted);
  if (!apiKey) {
    return fail(c, "AI 密钥解析失败，请重新保存配置", 400);
  }

  // 组装上下文：世界简介 + 已有条目标题 + 当前条目正文
  const [entryTitles, currentEntry] = await Promise.all([
    c.env.DB.prepare("SELECT title FROM entries WHERE world_id = ? ORDER BY updated_at DESC LIMIT 20")
      .bind(worldId)
      .all<{ title: string }>(),
    entryId
      ? c.env.DB.prepare("SELECT title FROM entries WHERE id = ? AND world_id = ?")
          .bind(entryId, worldId)
          .first<{ title: string }>()
      : Promise.resolve(null),
  ]);

  const contextParts = [
    `世界名称：${access.world.name}`,
    access.world.intro ? `世界简介：${access.world.intro}` : "",
    entryTitles.results?.length
      ? `已有条目（供参考，保持设定一致）：${entryTitles.results.map((row) => row.title).join("、")}`
      : "",
    currentEntry ? `当前条目：${currentEntry.title}` : "",
  ].filter(Boolean);

  const taskText = KIND_PROMPTS[kind] ?? "";
  const userPrompt = [
    contextParts.join("\n"),
    kind === "expand" ? `${taskText}\n\n原文：\n${selectedText}` : taskText,
    instruction ? `补充要求：${instruction}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  // 调用用户配置的 OpenAI 兼容接口
  let aiResponse: Response;
  try {
    aiResponse = await fetch(`${settings.base_url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          {
            role: "system",
            content: "你是世界观创作助手，用简体中文写作，内容与已有设定保持一致。只输出正文，不要解释或客套。",
          },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.8,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    await logAiUsage(c.env.DB, user.id, worldId, kind, false);
    return fail(c, "AI 服务连接失败，请检查网络或 Base URL");
  }

  if (!aiResponse.ok) {
    await logAiUsage(c.env.DB, user.id, worldId, kind, false);
    if (aiResponse.status === 401 || aiResponse.status === 403) {
      return fail(c, "API Key 无效或无权限，请检查 AI 配置");
    }
    if (aiResponse.status === 429) {
      return fail(c, "AI 请求过于频繁或额度不足，请稍后再试");
    }
    return fail(c, `AI 服务返回错误（${aiResponse.status}）`);
  }

  const payload = (await aiResponse.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  const text = payload?.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) {
    await logAiUsage(c.env.DB, user.id, worldId, kind, false);
    return fail(c, "AI 未返回内容，请重试");
  }

  await logAiUsage(c.env.DB, user.id, worldId, kind, true);
  return ok(c, { text });
});

export default aiRoutes;
