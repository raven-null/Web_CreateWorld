import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { showToast } from "../lib/toast";

/** 举报原因预设 */
const REASONS = ["垃圾广告", "违规内容", "不实信息", "侵权内容", "其他"];

interface ReportDialogProps {
  /** 举报对象类型 */
  targetType: "world" | "entry" | "user";
  /** 举报对象 id */
  targetId: string;
  /** 举报对象名称（展示用） */
  targetName: string;
  /** 关闭弹层 */
  onClose: () => void;
}

/**
 * 举报弹层：选择原因 + 补充说明，提交后由站点管理员处理。
 */
export default function ReportDialog({ targetType, targetId, targetName, onClose }: ReportDialogProps) {
  const [reason, setReason] = useState(REASONS[0] ?? "其他");
  const [detail, setDetail] = useState("");
  const [submitting, setSubmitting] = useState(false);

  /** 提交举报 */
  const handleSubmit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    setSubmitting(true);
    try {
      await api("/api/reports", {
        method: "POST",
        body: { targetType, targetId, reason, detail },
      });
      showToast("success", "举报已提交，感谢反馈");
      onClose();
    } catch (err) {
      showToast("error", (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(clickEvent) => clickEvent.stopPropagation()}>
        <h2 className="section-title">举报「{targetName}」</h2>
        <form className="form" style={{ maxWidth: "none" }} onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="reportReason">举报原因</label>
            <select id="reportReason" value={reason} onChange={(event) => setReason(event.target.value)}>
              {REASONS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="reportDetail">补充说明（可选）</label>
            <textarea
              id="reportDetail"
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
              placeholder="描述具体问题，方便管理员核实"
            />
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button type="submit" className="btn" disabled={submitting}>
              {submitting ? "提交中…" : "提交举报"}
            </button>
            <button type="button" className="btn ghost" onClick={onClose}>
              取消
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
