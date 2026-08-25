/**
 * 首次使用引导的外壳：一个盖住整个内容区的层。
 *
 * 只做三件事——渲染 `ONBOARDING_STEPS` 里的一步、翻页、结束时写标记。
 * 文案在 `steps.ts`，配模型表单在 `ModelStep.tsx`，标记策略在 `state.ts`；
 * 这里不该出现任何一句业务文案。
 *
 * 它盖在 TitleBar 之下而不是盖住整个窗口：无边框窗口的拖动、关闭全靠那条
 * 标题栏，糊住它等于把人关在引导里。
 */

import { useCallback, useEffect, useState } from "react";
import { ICONS } from "./icons";
import ModelStep from "./ModelStep";
import { ONBOARDING_STEPS } from "./steps";

interface Props {
  /**
   * 关掉引导。`completed` 为 true 表示这次是「用户看过了」——跳过与走完都算，
   * 由 App 决定要不要写标记；从帮助菜单重看时关闭不写。
   */
  onClose: (completed: boolean) => void;
  /** 重看模式：不写标记，按钮文案也换成「关闭」。 */
  reviewing?: boolean;
}

export default function OnboardingOverlay({ onClose, reviewing }: Props) {
  const [index, setIndex] = useState(0);
  const step = ONBOARDING_STEPS[index];
  const isLast = index === ONBOARDING_STEPS.length - 1;

  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);
  const next = useCallback(() => {
    setIndex((i) => {
      if (i < ONBOARDING_STEPS.length - 1) return i + 1;
      return i;
    });
  }, []);

  // 键盘翻页。第 5 步是表单，方向键在 select / input 里另有含义，所以只在
  // 文案页上接管；Esc 任何时候都能退出（等同「跳过」）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose(!reviewing);
        return;
      }
      if (step?.kind === "model") return;
      if (e.key === "ArrowRight") isLast ? onClose(!reviewing) : next();
      if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back, next, isLast, onClose, reviewing, step?.kind]);

  if (!step) return null;

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-base text-ink">
      {/* 跳过：右上角，任何一步都在 */}
      <div className="flex shrink-0 justify-end px-5 pt-4">
        <button
          onClick={() => onClose(!reviewing)}
          className="rounded-md px-2 py-1 text-sm text-dim hover:text-ink"
        >
          {reviewing ? "关闭" : "跳过"}
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-4">
        <div className="flex w-full max-w-2xl flex-col items-center gap-6">
          <div className="text-center text-xs tracking-[0.35em] text-accent">
            — {step.eyebrow} —
          </div>

          {step.bullets && (
            <div className="flex w-full flex-col gap-2">
              {step.bullets.map((b) => (
                <div
                  key={b.title}
                  className="flex items-start gap-3 rounded-xl border border-edge bg-card px-4 py-3 text-left"
                >
                  <span className="mt-0.5 shrink-0 text-dim">{ICONS[b.icon]}</span>
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{b.title}</div>
                    <div className="mt-0.5 text-xs leading-relaxed text-dim">{b.body}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="text-center">
            <h1 className="text-3xl font-semibold tracking-tight">{step.title}</h1>
            <p className="mt-2 text-sm text-dim">{step.subtitle}</p>
          </div>

          {step.kind === "model" && <ModelStep />}
        </div>
      </div>

      {/* 底部：上一步 / 圆点 / 下一步 */}
      <div className="flex shrink-0 items-center justify-between gap-4 px-6 pb-6 pt-2">
        <button
          onClick={back}
          disabled={index === 0}
          className="rounded-md px-3 py-1.5 text-sm text-dim hover:text-ink disabled:invisible"
        >
          上一步
        </button>

        <div className="flex items-center gap-2">
          {ONBOARDING_STEPS.map((s, i) => (
            <button
              key={s.title}
              onClick={() => setIndex(i)}
              title={s.title}
              aria-label={s.title}
              className={`h-1.5 w-1.5 rounded-full transition-opacity ${
                i === index ? "bg-accent" : "bg-dim opacity-40 hover:opacity-70"
              }`}
            />
          ))}
        </div>

        <button
          onClick={() => (isLast ? onClose(!reviewing) : next())}
          className="rounded-md bg-accent px-4 py-1.5 text-sm text-[var(--accent-contrast)] hover:opacity-90"
        >
          {isLast ? (reviewing ? "关闭" : "开始使用") : "下一步"}
        </button>
      </div>
    </div>
  );
}
