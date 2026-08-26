/**
 * Word (`.docx`) → markdown, for the file preview.
 *
 * A *reading* view, not a converter: headings, lists, tables, bold/italic and
 * hyperlinks survive; fonts, colours, columns, footnotes, headers/footers and
 * embedded images do not. Rendering the result through the app's existing
 * markdown pipeline is the whole point — one renderer, one look, no new deps.
 *
 * Only `word/document.xml` (plus numbering and relationships) is read. Tracked
 * changes resolve to the accepted text: inserted runs are kept, deleted runs
 * dropped, which is what the document "says" today.
 */

import { attr, deepText, element, elements, parseXml, path, rootOf, type XmlNode } from "./xml";
import type { ZipArchive } from "./zip";

export interface DocxDocument {
  markdown: string;
  /** Images were present but are not rendered; the preview says so. */
  imageCount: number;
}

/** Run containers whose children are more runs — walked through, not printed. */
const RUN_CONTAINERS = new Set(["hyperlink", "ins", "smartTag", "sdt", "sdtContent", "fldSimple", "bdo", "dir"]);

/** Subtrees that carry no body text: deletions, drawings, field instructions. */
const SKIPPED = new Set(["del", "drawing", "pict", "object", "instrText", "delInstrText", "rPh"]);

/** Escape the markdown-significant characters that can appear in body text. */
function escapeInline(s: string): string {
  return s.replace(/([\\`*_[\]{}|<>])/g, "\\$1");
}

/** Escape a leading marker so a plain paragraph is not read as a block. */
function escapeLeading(s: string): string {
  return s.replace(/^(\s*)([#>+=]|-(?=\s)|\d+\.(?=\s))/, "$1\\$2");
}

/** Heading level from a paragraph style id, or 0 when it is not a heading. */
export function headingLevel(styleId: string | undefined): number {
  if (!styleId) return 0;
  const id = styleId.trim();
  if (/^Title$/i.test(id)) return 1;
  // Word writes "Heading2" in English builds and "标题 2" / "3" in localized
  // ones (the style id itself is localized when the document was authored in
  // a localized Word).
  const m = /^(?:Heading|heading|标题|見出し|제목)\s*([1-9])$/.exec(id) ?? /^([1-9])$/.exec(id);
  if (!m) return 0;
  return Math.min(6, Number(m[1]));
}

/** `numId` → bullet vs ordered, from `word/numbering.xml`. */
async function readNumbering(zip: ZipArchive): Promise<Map<string, boolean>> {
  const ordered = new Map<string, boolean>();
  if (!zip.has("word/numbering.xml")) return ordered;
  let root: XmlNode | null;
  try {
    root = rootOf(parseXml(await zip.textOf("word/numbering.xml")));
  } catch {
    return ordered;
  }
  if (!root) return ordered;
  // abstractNumId → the level-0 format ("bullet" or a number format).
  const abstractFmt = new Map<string, string>();
  for (const a of elements(root, "abstractNum")) {
    const id = attr(a, "abstractNumId");
    if (id === undefined) continue;
    const lvl = elements(a, "lvl").find((l) => (attr(l, "ilvl") ?? "0") === "0") ?? element(a, "lvl");
    abstractFmt.set(id, attr(element(lvl, "numFmt"), "val") ?? "bullet");
  }
  for (const num of elements(root, "num")) {
    const numId = attr(num, "numId");
    if (numId === undefined) continue;
    const abstractId = attr(element(num, "abstractNumId"), "val");
    const fmt = abstractId !== undefined ? abstractFmt.get(abstractId) : undefined;
    ordered.set(numId, fmt !== undefined && fmt !== "bullet" && fmt !== "none");
  }
  return ordered;
}

/** `r:id` → target, from a part's `_rels` sidecar. */
async function readRels(zip: ZipArchive, part: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const slash = part.lastIndexOf("/");
  const relsPath = `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
  if (!zip.has(relsPath)) return out;
  try {
    const root = rootOf(parseXml(await zip.textOf(relsPath)));
    for (const rel of elements(root, "Relationship")) {
      const id = attr(rel, "Id");
      const target = attr(rel, "Target");
      if (id && target) out.set(id, target);
    }
  } catch {
    // A missing or broken rels part only costs link targets.
  }
  return out;
}

/** Inline markdown for one run, with emphasis applied outside the whitespace. */
function runMarkdown(run: XmlNode): string {
  let text = "";
  for (const c of run.children) {
    if (SKIPPED.has(c.local)) continue;
    switch (c.local) {
      case "t":
        text += c.text;
        break;
      case "tab":
        text += "  ";
        break;
      case "br":
      case "cr":
        text += "\n";
        break;
      case "noBreakHyphen":
        text += "-";
        break;
      case "softHyphen":
        break;
      default:
        break;
    }
  }
  if (!text) return "";
  const escaped = escapeInline(text);
  const rPr = element(run, "rPr");
  // `w:b` with val="0"/"false" switches bold back off inside a bold style.
  const on = (local: string) => {
    const el = element(rPr, local);
    if (!el) return false;
    const val = attr(el, "val");
    return val === undefined || !/^(0|false|off)$/i.test(val);
  };
  const marks = `${on("b") ? "**" : ""}${on("i") ? "*" : ""}`;
  if (!marks) return escaped;
  // Emphasis cannot span the surrounding spaces, so lift them out.
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(escaped);
  if (!m || !m[2]) return escaped;
  return `${m[1]}${marks}${m[2]}${marks.split("").reverse().join("")}${m[3]}`;
}

/** Inline markdown for everything under a paragraph (or a table cell). */
function inlineMarkdown(parent: XmlNode, rels: Map<string, string>): string {
  let out = "";
  for (const child of parent.children) {
    if (SKIPPED.has(child.local)) continue;
    if (child.local === "r") {
      out += runMarkdown(child);
    } else if (child.local === "hyperlink") {
      const inner = inlineMarkdown(child, rels);
      const target = attr(child, "id") !== undefined ? rels.get(attr(child, "id")!) : undefined;
      // Anchor-only links (same-document bookmarks) have no target worth
      // rendering, so they stay plain text.
      out += target && inner ? `[${inner}](${target})` : inner;
    } else if (RUN_CONTAINERS.has(child.local)) {
      out += inlineMarkdown(child, rels);
    }
  }
  return out;
}

/** One `w:tbl` as a GFM table. Returns "" for a table with no rows. */
function tableMarkdown(tbl: XmlNode, rels: Map<string, string>): string {
  const rows: string[][] = [];
  for (const tr of elements(tbl, "tr")) {
    const cells = elements(tr, "tc").map((tc) =>
      elements(tc, "p")
        .map((p) => inlineMarkdown(p, rels))
        // A cell can hold several paragraphs; a GFM cell is one line.
        .filter((s) => s.trim() !== "")
        .join(" ")
        .replace(/\s*\n\s*/g, " ")
        .trim(),
    );
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
  const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
  const [header, ...body] = rows;
  return [line(header), `|${" --- |".repeat(width)}`, ...body.map(line)].join("\n");
}

/** One block: its markdown plus whether it is a list item (affects joining). */
interface Block {
  md: string;
  listItem: boolean;
}

function paragraphBlock(p: XmlNode, rels: Map<string, string>, ordered: Map<string, boolean>): Block | null {
  const inline = inlineMarkdown(p, rels).replace(/\s+$/, "");
  const pPr = element(p, "pPr");
  const styleId = attr(element(pPr, "pStyle"), "val");
  if (inline.trim() === "") return null;

  const level = headingLevel(styleId);
  if (level > 0) {
    return { md: `${"#".repeat(level)} ${inline.trim().replace(/\n+/g, " ")}`, listItem: false };
  }

  const numPr = element(pPr, "numPr");
  if (numPr) {
    const numId = attr(element(numPr, "numId"), "val");
    const ilvl = Number(attr(element(numPr, "ilvl"), "val") ?? "0");
    const indent = "  ".repeat(Math.max(0, Math.min(5, ilvl)));
    const marker = numId !== undefined && ordered.get(numId) ? "1." : "-";
    return { md: `${indent}${marker} ${inline.trim().replace(/\n+/g, " ")}`, listItem: true };
  }

  if (styleId && /^(Quote|IntenseQuote|引用)/i.test(styleId)) {
    return { md: inline.trim().split("\n").map((l) => `> ${l}`).join("\n"), listItem: false };
  }
  // A hard break inside a paragraph becomes a markdown hard break.
  return { md: escapeLeading(inline).replace(/\n/g, "  \n"), listItem: false };
}

export async function docxToMarkdown(zip: ZipArchive): Promise<DocxDocument> {
  const part = "word/document.xml";
  if (!zip.has(part)) throw new Error("不是有效的 docx（缺少 word/document.xml）");
  const doc = parseXml(await zip.textOf(part));
  const body = element(rootOf(doc), "body");
  if (!body) throw new Error("不是有效的 docx（缺少 body）");

  const [rels, ordered] = await Promise.all([readRels(zip, part), readNumbering(zip)]);

  const blocks: Block[] = [];
  let imageCount = 0;
  for (const child of body.children) {
    if (child.local === "p") {
      // Count images before the paragraph's drawings are skipped.
      imageCount += countImages(child);
      const block = paragraphBlock(child, rels, ordered);
      if (block) blocks.push(block);
    } else if (child.local === "tbl") {
      imageCount += countImages(child);
      const md = tableMarkdown(child, rels);
      if (md) blocks.push({ md, listItem: false });
    }
  }

  let markdown = "";
  blocks.forEach((block, i) => {
    if (i > 0) markdown += block.listItem && blocks[i - 1].listItem ? "\n" : "\n\n";
    markdown += block.md;
  });
  return { markdown, imageCount };
}

function countImages(n: XmlNode): number {
  let count = n.local === "drawing" || n.local === "pict" ? 1 : 0;
  // A drawing's own children are never images in their own right.
  if (count === 0) for (const c of n.children) count += countImages(c);
  return count;
}

/** Exported for tests: the paragraph/table walk without the zip layer. */
export const _internal = { escapeInline, escapeLeading, inlineMarkdown, tableMarkdown, paragraphBlock, deepText };
