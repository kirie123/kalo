import { describe, expect, test } from "bun:test";
import { mergeSpawnEnv } from "./spawn-env";

describe("spawn environment merge", () => {
  test("Windows task values replace inherited keys regardless of spelling", () => {
    for (const [inherited, override] of [["Path", "PATH"], ["PATH", "Path"]]) {
      const base = { [inherited]: "parent", SystemRoot: "system", KEEP: "yes" };
      const extra = { [override]: "job", SYSTEMROOT: "task-system" };
      const result = mergeSpawnEnv(base, extra, "win32");
      expect(result).toEqual({ KEEP: "yes", [override]: "job", SYSTEMROOT: "task-system" });
      expect(base[inherited]).toBe("parent");
      expect(extra[override]).toBe("job");
    }
  });

  test("Windows collapses duplicate inherited keys and honors empty or omitted values", () => {
    expect(mergeSpawnEnv({ Path: "first", PATH: "last" }, undefined, "win32")).toEqual({ PATH: "last" });
    expect(mergeSpawnEnv({ Path: "parent" }, { PATH: "" }, "win32")).toEqual({ PATH: "" });
    expect(mergeSpawnEnv({ Path: "parent" }, { PATH: undefined }, "win32")).toEqual({ PATH: undefined });
  });

  test("POSIX preserves distinct case-sensitive keys", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(mergeSpawnEnv({ PATH: "parent", Path: "other" }, { PATH: "job" }, platform))
        .toEqual({ PATH: "job", Path: "other" });
    }
  });
});
