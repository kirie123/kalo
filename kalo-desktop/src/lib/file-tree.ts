import type { GitEntry } from "../types";

export interface PathCrumb { name: string; path: string }

/** Preserve drive, UNC share and POSIX roots as indivisible navigation targets. */
export function pathBreadcrumbs(path: string): PathCrumb[] {
  const normalized = path.replace(/\\/g, "/");
  const anchor = /^(?:\/\/[^/]+\/[^/]+|[a-z]:\/|\/)/i.exec(normalized)?.[0] ?? "";
  const crumbs: PathCrumb[] = anchor ? [{ name: anchor.replace(/\/$/, "") || "/", path: anchor }] : [];
  let current = anchor.replace(/\/$/, "");
  for (const name of normalized.slice(anchor.length).split("/").filter(Boolean)) {
    current = current ? `${current}/${name}` : anchor ? `/${name}` : name;
    crumbs.push({ name, path: current });
  }
  return crumbs;
}

export function parentDirectory(path: string): string | null {
  const crumbs = pathBreadcrumbs(path);
  return crumbs.length > 1 ? crumbs[crumbs.length - 2].path : null;
}

export function fileBaseName(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || path;
}

export interface ChangeNode {
  name: string;
  path: string;
  isDir: boolean;
  entry: GitEntry | null;
  children: ChangeNode[];
}

/** Git already supplies every changed path; no filesystem traversal is needed. */
export function changedFileTree(root: string, entries: GitEntry[], query = ""): ChangeNode[] {
  const nodes = new Map<string, ChangeNode>();
  const roots: ChangeNode[] = [];
  const filter = query.trim().replace(/\\/g, "/").toLocaleLowerCase();
  for (const entry of entries) {
    const relative = entry.relPath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (filter && !relative.toLocaleLowerCase().includes(filter)) continue;
    const parts = relative.split("/").filter(Boolean);
    let children = roots;
    for (let index = 0; index < parts.length; index++) {
      const key = parts.slice(0, index + 1).join("/");
      const leaf = index === parts.length - 1;
      let node = nodes.get(key);
      if (!node) {
        node = { name: parts[index], path: leaf ? entry.path : `${root.replace(/[\\/]+$/, "")}/${key}`, isDir: !leaf || entry.isDir, entry: null, children: [] };
        nodes.set(key, node);
        children.push(node);
      }
      if (leaf) node.entry = entry;
      children = node.children;
    }
  }
  const sort = (list: ChangeNode[]) => {
    list.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    for (const node of list) sort(node.children);
  };
  sort(roots);
  return roots;
}
