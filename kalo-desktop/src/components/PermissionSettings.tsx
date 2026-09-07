import { useEffect, useState } from "react";
import { readDefaultPermissionMode, writeDefaultPermissionMode } from "../lib/pi-bridge";
import { PERMISSION_MODE_LABELS, PERMISSION_MODES, type PermissionMode } from "../types";
import { Section } from "./SettingsPage";

/**
 * Global default permission mode (doc/2026-09-07-权限模式.md).
 *
 * Deliberately labelled as applying to NEW sessions only: the engine reads this
 * when a session is created and pins the result into that session's log, so an
 * ongoing conversation never silently changes its authorization level.
 */
export default function PermissionSettings() {
  const [mode, setMode] = useState<PermissionMode | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void readDefaultPermissionMode()
      .then((value) => {
        if (!cancelled) setMode(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = async (next: PermissionMode) => {
    const previous = mode;
    setMode(next);
    setError(undefined);
    try {
      await writeDefaultPermissionMode(next);
    } catch (err) {
      setMode(previous);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Section title="权限模式">
      <p className="mb-3 text-sm leading-relaxed text-dim">
        新建对话的默认档位。已有对话保留自己的档位，改这里不会影响正在进行的会话；每个对话也可以在输入框旁单独切换。
      </p>

      <div className="flex flex-col gap-2">
        {PERMISSION_MODES.map((value) => (
          <button
            key={value}
            onClick={() => void choose(value)}
            disabled={mode === undefined}
            className={`flex items-start gap-2.5 rounded-md border px-3 py-2 text-left ${
              mode === value ? "border-dim bg-base" : "border-edge hover:bg-base"
            }`}
          >
            <span className="w-3 shrink-0 pt-0.5 text-center text-[var(--ok)]">{mode === value ? "✓" : ""}</span>
            <span className="min-w-0">
              <span className="block text-sm text-ink">{PERMISSION_MODE_LABELS[value].label}</span>
              <span className="block text-xs text-dim">{PERMISSION_MODE_LABELS[value].hint}</span>
            </span>
          </button>
        ))}
      </div>

      <p className="mt-3 text-xs leading-relaxed text-dim">
        说明：权限模式拦的是模型的误操作，不是刻意的绕过。被放行的命令内部仍可做任何事，用 bash
        写文件也能越过路径判定。真正需要隔离的场景请另行准备沙箱环境。
      </p>

      {error && <p className="mt-2 text-xs text-[var(--err)]">读写设置失败：{error}</p>}
    </Section>
  );
}
