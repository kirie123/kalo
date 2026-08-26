/**
 * Tiny XML reader for the OOXML parts behind the docx / xlsx preview.
 *
 * `DOMParser` is not used on purpose: it does not exist under vitest's node
 * environment, so every parser built on it would be untestable, and pulling
 * in jsdom for a preview feature is not a trade worth making. The subset here
 * is what Word and Excel actually emit — well-formed, no DTD subsets, no
 * namespace trickery — and it is deliberately tolerant: a malformed tail
 * yields a shorter tree rather than an exception, because half a preview beats
 * an error message.
 */

export interface XmlNode {
  /** Qualified name as written, e.g. `w:p`. */
  name: string;
  /** Local part, e.g. `p`. */
  local: string;
  /** Keyed by qualified name, values entity-decoded. */
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Character data directly inside this element (entity-decoded). */
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Lone surrogates and out-of-range code points would throw; leaving the
      // reference verbatim is the honest fallback.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function localName(qname: string): string {
  const i = qname.indexOf(":");
  return i < 0 ? qname : qname.slice(i + 1);
}

/** End of the tag starting at `lt`, skipping `>` inside quoted attributes. */
function findTagEnd(src: string, lt: number): number {
  let quote = "";
  for (let i = lt + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(s))) {
    attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? "");
  }
  return attrs;
}

function node(name: string, attrs: Record<string, string>): XmlNode {
  return { name, local: localName(name), attrs, children: [], text: "" };
}

/**
 * Parse a document into a tree. The result is a synthetic `#document` node;
 * its single element child is the real root (`children[0]` for well-formed
 * input).
 */
export function parseXml(src: string): XmlNode {
  const doc = node("#document", {});
  const stack: XmlNode[] = [doc];
  let i = 0;

  const top = () => stack[stack.length - 1];

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      top().text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(src.slice(i, lt));

    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      top().text += src.slice(lt + 9, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    // Prolog / processing instruction / DOCTYPE: skipped wholesale. OOXML has
    // no internal DTD subset, so a plain scan to `>` is enough.
    if (src.startsWith("<?", lt) || src.startsWith("<!", lt)) {
      const end = src.indexOf(">", lt + 2);
      i = end < 0 ? src.length : end + 1;
      continue;
    }

    const gt = findTagEnd(src, lt);
    if (gt < 0) break; // truncated tag: keep what we have
    const inner = src.slice(lt + 1, gt);

    if (inner[0] === "/") {
      const name = inner.slice(1).trim();
      // Pop to the matching open element. An unmatched close tag is ignored
      // rather than collapsing the whole stack.
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d].name === name) {
          stack.length = d;
          break;
        }
      }
      i = gt + 1;
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameEnd = body.search(/[\s/]/);
    const name = (nameEnd < 0 ? body : body.slice(0, nameEnd)).trim();
    if (!name) {
      i = gt + 1;
      continue;
    }
    const el = node(name, nameEnd < 0 ? {} : parseAttrs(body.slice(nameEnd)));
    top().children.push(el);
    if (!selfClosing) stack.push(el);
    i = gt + 1;
  }
  return doc;
}

/** The document's root element, or null for empty/garbage input. */
export function rootOf(doc: XmlNode): XmlNode | null {
  return doc.children[0] ?? null;
}

/** Direct children with the given local name. */
export function elements(parent: XmlNode | null, local: string): XmlNode[] {
  if (!parent) return [];
  return parent.children.filter((c) => c.local === local);
}

/** First direct child with the given local name. */
export function element(parent: XmlNode | null, local: string): XmlNode | null {
  if (!parent) return null;
  return parent.children.find((c) => c.local === local) ?? null;
}

/** Same, but following a chain of local names: `path(body, "pPr", "pStyle")`. */
export function path(parent: XmlNode | null, ...locals: string[]): XmlNode | null {
  let cur = parent;
  for (const l of locals) {
    cur = element(cur, l);
    if (!cur) return null;
  }
  return cur;
}

/**
 * Attribute by name: an exact match wins, otherwise any prefixed form
 * (`attr(n, "val")` finds `w:val`). Prefixes in OOXML are stable in practice
 * but nothing here needs to depend on them.
 */
export function attr(n: XmlNode | null, name: string): string | undefined {
  if (!n) return undefined;
  const exact = n.attrs[name];
  if (exact !== undefined) return exact;
  const suffix = `:${name}`;
  for (const key of Object.keys(n.attrs)) {
    if (key.endsWith(suffix)) return n.attrs[key];
  }
  return undefined;
}

/** All character data in the subtree, in document order. */
export function deepText(n: XmlNode | null, skip?: (child: XmlNode) => boolean): string {
  if (!n) return "";
  let out = n.text;
  for (const c of n.children) {
    if (skip?.(c)) continue;
    out += deepText(c, skip);
  }
  return out;
}
