import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** Inputs are canonical workspace roots; node:path handles native case/separators. */
export function overlaps(a: string, b: string): boolean {
  const inside = (root: string, target: string) => {
    const rel = relative(root, target);
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
  };
  return inside(a, b) || inside(b, a);
}

export function workspace(value: string): string {
  if (!isAbsolute(value)) throw new Error("工作目录必须是绝对路径");
  const path = realpathSync(value);
  if (!statSync(path).isDirectory()) throw new Error("工作目录不存在或不是目录");
  return path;
}
/** Follow existing symlinks, including a non-existent write target's parent. */
export function contained(root: string, value: string, mustExist = false): string {
  const target = resolve(root, value);
  let parent = target;
  while (!existsSync(parent)) {
    if (mustExist) throw new Error("成果文件不存在");
    const next = dirname(parent);
    if (next === parent) throw new Error("无法解析文件路径");
    parent = next;
  }
  const canonical = resolve(realpathSync(parent), relative(parent, target));
  const rel = relative(realpathSync(root), canonical);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw new Error("文件超出本任务授权目录");
  return canonical;
}
