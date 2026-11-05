/** Environment keys are case-insensitive only on Windows. Later layers win. */
export function mergeSpawnEnv(
  base: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv | undefined,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return { ...base, ...extra };
  const result: NodeJS.ProcessEnv = {};
  const keys = new Map<string, string>();
  for (const layer of [base, extra]) {
    for (const [key, value] of Object.entries(layer ?? {})) {
      const canonical = key.toUpperCase();
      const previous = keys.get(canonical);
      if (previous !== undefined) delete result[previous];
      result[key] = value;
      keys.set(canonical, key);
    }
  }
  return result;
}
