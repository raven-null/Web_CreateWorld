import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { showToast } from "../lib/toast";

/** AI 供应商预设（OpenAI 兼容地址） */
const AI_PRESETS = [
  { id: "zhipu", name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  { id: "custom", name: "自定义（OpenAI 兼容）", baseUrl: "", model: "" },
];

/**
 * 个人设置页：修改昵称与密码。
 * 用户名不可修改（用于登录与贡献记录）。
 */
export default function SettingsPage() {
  const { data: session, refetch } = authClient.useSession();
  const [displayName, setDisplayName] = useState("");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // AI 配置
  const [aiProvider, setAiProvider] = useState("zhipu");
  const [aiBaseUrl, setAiBaseUrl] = useState(AI_PRESETS[0]?.baseUrl ?? "");
  const [aiModel, setAiModel] = useState(AI_PRESETS[0]?.model ?? "");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiHasKey, setAiHasKey] = useState(false);
  const [savingAi, setSavingAi] = useState(false);

  // 会话加载后填入当前昵称
  useEffect(() => {
    if (session?.user) {
      setDisplayName(session.user.name);
    }
  }, [session]);

  // 加载已保存的 AI 配置（不回显密钥明文）
  useEffect(() => {
    if (!session?.user) {
      return;
    }
    api<{ provider: string; baseUrl: string; model: string; hasKey: boolean }>("/api/ai/settings")
      .then((data) => {
        setAiProvider(data.provider);
        setAiHasKey(data.hasKey);
        if (data.baseUrl) {
          setAiBaseUrl(data.baseUrl);
        }
        if (data.model) {
          setAiModel(data.model);
        }
      })
      .catch(() => {
        // 未配置时保持默认预设
      });
  }, [session]);

  /** 切换供应商预设：带出默认地址与模型 */
  const handleProviderChange = (providerId: string) => {
    setAiProvider(providerId);
    const preset = AI_PRESETS.find((item) => item.id === providerId);
    if (preset && preset.id !== "custom") {
      setAiBaseUrl(preset.baseUrl);
      setAiModel(preset.model);
    }
  };

  /** 保存 AI 配置；密钥留空表示保留原密钥 */
  const handleSaveAi = async (event: FormEvent) => {
    event.preventDefault();
    setSavingAi(true);
    try {
      await api("/api/ai/settings", {
        method: "PUT",
        body: { provider: aiProvider, baseUrl: aiBaseUrl.trim(), model: aiModel.trim(), apiKey: aiApiKey.trim() },
      });
      setAiApiKey("");
      setAiHasKey(true);
      showToast("success", "AI 配置已保存（密钥加密存储）");
    } catch (err) {
      showToast("error", (err as Error).message);
    } finally {
      setSavingAi(false);
    }
  };

  if (!session?.user) {
    return (
      <>
        <h1 className="page-title">个人设置</h1>
        <div className="notice">请先登录</div>
      </>
    );
  }

  /** 保存昵称 */
  const handleSaveName = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api("/api/me", { method: "PATCH", body: { displayName: displayName.trim() } });
      await refetch();
      showToast("success", "昵称已更新");
    } catch (err) {
      showToast("error", (err as Error).message);
    }
  };

  /** 修改密码（需验证当前密码） */
  const handleChangePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      showToast("warning", "两次输入的新密码不一致");
      return;
    }
    const { error } = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });
    if (error) {
      showToast("error", error.message ?? "修改失败");
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    showToast("success", "密码已修改，其他设备已退出登录");
  };

  return (
    <>
      <h1 className="page-title">个人设置</h1>
      <p className="page-subtitle">
        @{session.user.username ?? ""}（用户名不可修改，用于登录）
      </p>

      <div className="section">
        <h2 className="section-title">昵称</h2>
        <form className="form" onSubmit={handleSaveName}>
          <div className="field">
            <label htmlFor="displayName">展示昵称</label>
            <input
              id="displayName"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          </div>
          <button type="submit" className="btn">
            保存昵称
          </button>
        </form>
      </div>

      <div className="section">
        <h2 className="section-title">修改密码</h2>
        <form className="form" onSubmit={handleChangePassword}>
          <div className="field">
            <label htmlFor="currentPassword">当前密码</label>
            <input
              id="currentPassword"
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="newPassword">新密码（至少 8 位）</label>
            <input
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="confirmPassword">确认新密码</label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <button type="submit" className="btn">
            修改密码
          </button>
        </form>
      </div>

      <div className="section">
        <h2 className="section-title">AI 助手配置</h2>
        <p className="page-subtitle" style={{ marginBottom: 14 }}>
          自带 API Key（BYOK），密钥加密存储、仅用于代你调用所选 AI 接口；免费通道可选智谱 GLM 或魔搭等托管地址。
        </p>
        <form className="form" onSubmit={handleSaveAi}>
          <div className="field">
            <label htmlFor="aiProvider">供应商</label>
            <select id="aiProvider" value={aiProvider} onChange={(event) => handleProviderChange(event.target.value)}>
              {AI_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="aiBaseUrl">Base URL（OpenAI 兼容）</label>
            <input
              id="aiBaseUrl"
              value={aiBaseUrl}
              onChange={(event) => setAiBaseUrl(event.target.value)}
              placeholder="https://..."
              required
            />
          </div>
          <div className="field">
            <label htmlFor="aiModel">模型名称</label>
            <input
              id="aiModel"
              value={aiModel}
              onChange={(event) => setAiModel(event.target.value)}
              placeholder="如 glm-4-flash / deepseek-chat"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="aiApiKey">API Key</label>
            <input
              id="aiApiKey"
              type="password"
              value={aiApiKey}
              onChange={(event) => setAiApiKey(event.target.value)}
              placeholder={aiHasKey ? "已配置（留空保持不变）" : "填写你的 API Key"}
              autoComplete="off"
            />
          </div>
          <button type="submit" className="btn" disabled={savingAi}>
            {savingAi ? "保存中…" : "保存 AI 配置"}
          </button>
        </form>
      </div>
    </>
  );
}
