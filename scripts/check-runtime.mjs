import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/** Run JavaScript CLIs with Node rather than platform-specific npm shims. */
export function packageStep(label, name, entry, args, cwd) {
  const root = path.dirname(require.resolve(`${name}/package.json`, { paths: [cwd] }));
  return [label, process.execPath, [path.join(root, entry), ...args], cwd];
}
