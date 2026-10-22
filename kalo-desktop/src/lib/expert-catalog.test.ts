import { describe, expect, it } from "vitest";
import type { Expert } from "../types";
import { expertDefinitionDir, filterExperts, needsExpertWorkspace } from "./expert-catalog";

const team: Expert = {
  id: "editors", name: "公众号运营", mission: "写稿与排版", enabled: true, createdAt: "2026-10-21",
  definitionDir: "C:/Users/test/.kalo/agent/experts/editors", kind: "team",
  members: [{ id: "writer", name: "方成", profession: "选题撰稿人", agentPath: "agents/writer.md" }],
};

describe("expert catalog and workspace choice", () => {
  it("prefers the definition field and accepts legacy entries", () => {
    expect(expertDefinitionDir({ ...team, workdir: "D:/old" })).toBe(team.definitionDir);
    expect(expertDefinitionDir({ ...team, definitionDir: undefined, workdir: "D:/old" })).toBe("D:/old");
  });
  it("allocates tasks outside definitions, including old output subdirectories", () => {
    expect(needsExpertWorkspace("", [team])).toBe(true);
    expect(needsExpertWorkspace("c:\\users\\test\\.kalo\\agent\\experts\\EDITORS\\", [team])).toBe(true);
    expect(needsExpertWorkspace(`${team.definitionDir}/outputs/old`, [team])).toBe(true);
  });
  it("preserves explicitly chosen task directories and segment boundaries", () => {
    expect(needsExpertWorkspace("D:/projects/my-wechat", [team])).toBe(false);
    expect(needsExpertWorkspace(`${team.definitionDir}-other`, [team])).toBe(false);
    expect(needsExpertWorkspace("/Users/me/tasks", [{ ...team, definitionDir: "/Users/me/experts/editor" }])).toBe(false);
  });
  it("searches names, missions and member professions", () => {
    for (const query of ["公众号", "排版", "方成", "撰稿", " WRITER "]) expect(filterExperts([team], query)).toEqual([team]);
    expect(filterExperts([team], "不存在")).toEqual([]);
  });
  it("filters legacy experts and teams independently", () => {
    const solo = { ...team, id: "solo", kind: undefined };
    expect(filterExperts([team, solo], "", "agent")).toEqual([solo]);
    expect(filterExperts([team, solo], "", "team")).toEqual([team]);
  });
});
