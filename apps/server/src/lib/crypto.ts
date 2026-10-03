/**
 * 文本加密工具：用于用户 AI API Key 的存储加密（AES-GCM）。
 * 密钥由环境变量 AI_KEY_SECRET 经 SHA-256 派生。
 */

/**
 * 从环境密钥派生 AES-GCM 加密密钥。
 * @param secret 环境密钥字符串
 * @returns CryptoKey
 */
async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * 加密文本，返回 base64(IV + 密文)。
 * @param secret 环境密钥
 * @param plain 明文
 * @returns base64 字符串
 */
export async function encryptText(secret: string, plain: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));

  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);

  let binary = "";
  for (const byte of combined) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * 解密 base64(IV + 密文)。
 * @param secret 环境密钥
 * @param encoded base64 字符串
 * @returns 明文；解密失败返回 null
 */
export async function decryptText(secret: string, encoded: string): Promise<string | null> {
  try {
    const key = await deriveKey(secret);
    const raw = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const iv = raw.slice(0, 12);
    const data = raw.slice(12);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
