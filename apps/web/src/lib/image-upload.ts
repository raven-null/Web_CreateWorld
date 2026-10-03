/**
 * 浏览器端图片处理与上传：
 * - 上传前转为 WebP 压缩（canvas），地图最长边 4096
 * - GIF 原样上传（canvas 转码会丢失动画）
 * - 老浏览器不支持 WebP 编码时回退原格式
 */

/**
 * 把图片文件压缩转为 WebP。
 * @param file 原始图片文件
 * @param maxEdge 最长边限制（像素）
 * @param quality WebP 质量（0-1）
 * @returns 压缩后的 Blob 或原文件
 */
export async function convertToWebp(file: File, maxEdge: number, quality = 0.85): Promise<Blob> {
  if (file.type === "image/gif") {
    return file;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
    if (!blob || blob.type !== "image/webp") {
      return file;
    }
    return blob;
  } catch {
    return file;
  }
}

/**
 * 上传图片到服务端（KV 存储），返回访问地址。
 * @param file 原始图片文件
 * @param maxEdge 最长边限制（头像/封面 1600，地图 4096）
 * @returns { key, url }
 * @throws 上传失败时抛出中文错误
 */
export async function uploadImage(file: File, maxEdge: number): Promise<{ key: string; url: string }> {
  const blob = await convertToWebp(file, maxEdge);
  const extension = blob.type.replace("image/", "").replace("jpeg", "jpg") || "bin";

  const form = new FormData();
  form.append("file", blob, `image.${extension}`);

  const response = await fetch("/api/images", { method: "POST", body: form, credentials: "include" });
  const payload = (await response.json().catch(() => null)) as
    | { ok: boolean; data?: { key: string; url: string }; error?: string }
    | null;
  if (!payload?.ok || !payload.data) {
    throw new Error(payload?.error ?? "图片上传失败");
  }
  return payload.data;
}
