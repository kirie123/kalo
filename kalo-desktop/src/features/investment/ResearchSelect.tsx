import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { selectLayout } from "./select-layout";

type Choice = { value: string; label: string; detail?: string };

/** A single-select combobox; keyboard focus stays on its trigger. */
export function ResearchSelect({ label, value, options, onChange }: {
  label: string; value: string; options: Choice[]; onChange: (value: string) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<ReturnType<typeof selectLayout>>({ left: 20, top: 20, bottom: undefined, width: 300, maxHeight: 300 });
  const selected = options.find(o => o.value === value);
  const show = () => { setActive(Math.max(0, options.findIndex(o => o.value === value))); setOpen(true); };
  const choose = (choice: Choice) => { onChange(choice.value); setOpen(false); trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    setPosition(selectLayout(rect, { width: window.innerWidth, height: window.innerHeight }));
  }, [open, options.length]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!trigger.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node)) setOpen(false);
    };
    const close = () => setOpen(false);
    const scroll = (e: Event) => { if (!menu.current?.contains(e.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", scroll, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", close); window.removeEventListener("scroll", scroll, true); };
  }, [open]);
  useEffect(() => { if (open) menu.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active, open]);
  return <>
    <button type="button" ref={trigger} className="research-select" role="combobox" aria-label={label}
      aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="listbox"
      aria-activedescendant={open && options[active] ? `${id}-${active}` : undefined}
      disabled={!options.length} onClick={() => open ? setOpen(false) : show()}
      onBlur={() => setOpen(false)} onKeyDown={e => {
        if (e.key === "Escape" || e.key === "Tab") { setOpen(false); if (e.key === "Escape") e.preventDefault(); return; }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          if (!open) { show(); return; }
          setActive(i => e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : Math.max(0, Math.min(options.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault(); if (open && options[active]) choose(options[active]); else show();
        }
      }}>
      <span className="research-select-value">{selected?.label ?? "请选择"}</span>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {open && createPortal(<div ref={menu} className="research-select-menu" style={position} onMouseDown={e => e.preventDefault()}>
      <div className="research-select-heading">{label}<span>{options.length} 项</span></div>
      <div id={id} role="listbox" aria-label={label}>
        {options.map((option, index) => <button type="button" role="option" tabIndex={-1} id={`${id}-${index}`} data-index={index}
          key={option.value} aria-selected={value === option.value} className={active === index ? "is-active" : ""}
          onPointerMove={() => setActive(index)} onClick={() => choose(option)}>
          <span><strong>{option.label}</strong>{option.detail && <small>{option.detail}</small>}</span>
          <span className="research-select-check" aria-hidden="true">{value === option.value ? "✓" : ""}</span>
        </button>)}
      </div>
    </div>, document.body)}
  </>;
}
