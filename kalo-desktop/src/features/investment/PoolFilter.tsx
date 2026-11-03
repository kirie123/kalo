import { categories, inCategory } from "./logic";
import type { Instrument } from "./types";

export function PoolFilter({ instruments, value, onChange }: {
  instruments: Instrument[]; value: string; onChange: (category: string) => void;
}) {
  return <div className="investment-tabs" aria-label="ETF 分类">
    {categories.map(category => <button type="button" key={category} aria-pressed={value === category} onClick={() => onChange(category)}>
      {category} <span>{inCategory(instruments, category).length}</span>
    </button>)}
  </div>;
}
