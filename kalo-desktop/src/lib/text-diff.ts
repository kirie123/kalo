/**
 * Minimal line diff, emitted in the same display format the engine's edit tool
 * produces (`<sign><padded line no> <content>`), so `DiffView` renders it
 * unchanged.
 *
 * Exists because some diffs are computed locally rather than reported by the
 * engine — comparing two directories on disk, for instance. Plain LCS: correct
 * and obvious, with a size cap instead of a cleverer algorithm, since anything
 * big enough to be slow is also too big to read.
 */

/** Above this many lines on either side, fall back to a whole-file replace. */
const LCS_MAX_LINES = 4000;

type Op = { kind: "eq" | "add" | "del"; text: string };

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // (n+1)*(m+1) Int32 table; bounded by the cap above.
  const dp = new Int32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] =
        a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "eq", text: a[i] });
      i++;
      j++;
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
      ops.push({ kind: "del", text: a[i++] });
    } else {
      ops.push({ kind: "add", text: b[j++] });
    }
  }
  while (i < n) ops.push({ kind: "del", text: a[i++] });
  while (j < m) ops.push({ kind: "add", text: b[j++] });
  return ops;
}

export interface DiffTextOptions {
  /** Context lines kept around each change. */
  context?: number;
}

/**
 * Diff two texts into DiffView's display format. Returns an empty string when
 * the two sides are identical.
 */
export function diffText(oldText: string, newText: string, opts: DiffTextOptions = {}): string {
  if (oldText === newText) return "";
  const context = opts.context ?? 3;
  const a = oldText.split("\n");
  const b = newText.split("\n");

  const ops: Op[] =
    a.length > LCS_MAX_LINES || b.length > LCS_MAX_LINES
      ? [...a.map((t): Op => ({ kind: "del", text: t })), ...b.map((t): Op => ({ kind: "add", text: t }))]
      : lcsOps(a, b);

  // Number the lines as they will be displayed.
  type Row = { sign: "+" | "-" | " "; no: number; text: string; changed: boolean };
  const rows: Row[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const op of ops) {
    if (op.kind === "eq") {
      oldNo++;
      newNo++;
      rows.push({ sign: " ", no: newNo, text: op.text, changed: false });
    } else if (op.kind === "del") rows.push({ sign: "-", no: ++oldNo, text: op.text, changed: true });
    else rows.push({ sign: "+", no: ++newNo, text: op.text, changed: true });
  }

  // Keep only windows around changes; collapse the rest into "...".
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (!r.changed) return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
  });

  const out: string[] = [];
  let skipping = false;
  rows.forEach((r, i) => {
    if (!keep[i]) {
      if (!skipping) {
        out.push("  ...");
        skipping = true;
      }
      return;
    }
    skipping = false;
    out.push(`${r.sign}${String(r.no).padStart(4)} ${r.text}`);
  });
  return out.join("\n");
}
