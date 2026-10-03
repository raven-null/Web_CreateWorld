import { Hono } from "hono";
import { fail, ok } from "../lib/response";
import { requireLogin, type AppVariables } from "../middleware/session";
import type { Env } from "../types";

/** 单张图片大小上限（客户端已压缩，服务端再兜底校验） */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** 允许的图片类型 */
const ALLOWED_TYPES = new Set(["image/webp", "image/png", "image/jpeg", "image/gif"]);

const imageRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * 上传图片（登录用户）。
 * body: multipart/form-data，字段 file；服务端存入 KV。
 */
imageRoutes.post("/images", requireLogin, async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail(c, "请选择图片文件");
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return fail(c, "仅支持 WebP / PNG / JPEG / GIF 图片");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return fail(c, "图片过大，请压缩到 8MB 以内");
  }

  const extension = file.type.split("/")[1] ?? "bin";
  const key = `${crypto.randomUUID()}.${extension}`;
  await c.env.IMAGES.put(key, await file.arrayBuffer(), {
    metadata: { contentType: file.type },
  });

  return ok(c, { key, url: `/api/images/${key}` }, 201);
});

/**
 * 读取图片（公开访问，边缘缓存一年）。
 * 本地开发时 Cache API 不生效，但 KV 读取同样很快。
 */
imageRoutes.get("/images/:key", async (c) => {
  const key = c.req.param("key");
  const cache = caches.default;
  const cacheKey = new Request(c.req.url, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  const { value, metadata } = await c.env.IMAGES.getWithMetadata<{ contentType?: string }>(key, {
    type: "arrayBuffer",
  });
  if (!value) {
    return fail(c, "图片不存在", 404);
  }

  const response = new Response(value, {
    headers: {
      "Content-Type": metadata?.contentType ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
});

export default imageRoutes;
