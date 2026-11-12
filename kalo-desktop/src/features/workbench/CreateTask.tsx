import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { WORKER_PROFILES, type WorkbenchRequest, type WorkerProfile } from "../../../shared/workbench";
import { PROFILE_LABELS } from "../../lib/workbench-view";

/** New task form. "加入待办" parks it in todo; "开始任务" routes immediately. */
export default function CreateTask({ defaultCwd, busy, perform, onCancel, onError }: {
  defaultCwd: string; busy: boolean; perform: (request: WorkbenchRequest) => Promise<void>;
  onCancel: () => void; onError: (message: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState(defaultCwd);
  const [allowShell, setAllowShell] = useState(false);
  const [profile, setProfile] = useState<WorkerProfile>("code");
  const submit = (draft: boolean) => void perform({ action: "create", actionId: "", prompt, cwd, allowShell, profile, draft });
  return <form className="wb-create" onSubmit={e => { e.preventDefault(); submit(false); }}>
    <label>希望完成什么？<textarea value={prompt} onChange={e => setPrompt(e.target.value)} required maxLength={12000} placeholder="例如：整理这个目录的研究资料，生成一份带出处的摘要。" /></label>
    <label>工作目录<div className="wb-row"><input value={cwd} onChange={e => setCwd(e.target.value)} required />
      <button type="button" className="wb-button" onClick={() => { void open({ directory: true }).then(dir => { if (typeof dir === "string") setCwd(dir); }).catch(err => onError(String(err))); }}>选择目录</button></div></label>
    <div className="wb-field">执行类型<div className="wb-options">{WORKER_PROFILES.map(p => <button key={p} type="button" className="wb-button" aria-pressed={profile === p} onClick={() => setProfile(p)}>{PROFILE_LABELS[p]}</button>)}</div></div>
    <label className="wb-checkbox"><input type="checkbox" checked={allowShell} onChange={e => setAllowShell(e.target.checked)} />允许执行本机命令（可访问本机资源，不是隔离沙箱；调研类始终不开放）</label>
    <p>任务使用已配置的默认模型，只开放任务目录内的文件工具。</p>
    <div className="wb-row">
      <button className="wb-button wb-primary" disabled={busy || !prompt.trim() || !cwd.trim()}>开始任务</button>
      <button type="button" className="wb-button" disabled={busy || !prompt.trim() || !cwd.trim()} onClick={() => submit(true)}>加入待办</button>
      <button type="button" className="wb-button" onClick={onCancel}>取消</button>
    </div>
  </form>;
}
