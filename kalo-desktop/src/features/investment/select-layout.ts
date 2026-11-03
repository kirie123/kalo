/** Leave room for the menu shadow, flip above when the lower space is short. */
export function selectLayout(rect: { left: number; top: number; bottom: number; width: number }, viewport: { width: number; height: number }) {
  const margin = 20, gap = 6;
  const width = Math.min(Math.max(rect.width, 300), Math.max(0, viewport.width - margin * 2));
  const below = Math.max(0, viewport.height - rect.bottom - margin - gap);
  const above = Math.max(0, rect.top - margin - gap);
  const down = below >= Math.min(240, above);
  return {
    left: Math.max(margin, Math.min(rect.left, viewport.width - width - margin)), width,
    maxHeight: Math.min(320, down ? below : above),
    top: down ? rect.bottom + gap : undefined,
    bottom: down ? undefined : viewport.height - rect.top + gap,
  };
}
