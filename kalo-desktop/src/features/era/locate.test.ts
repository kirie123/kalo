import { describe, expect, it } from "vitest";
import { formatPython, parseProbe, rewritesPython, usablePythons, withPython } from "./locate";

const PY = "/c/Users/x/miniforge3/python.exe";

describe("parseProbe", () => {
  it("reads the tagged report", () => {
    const p = parseProbe(
      [
        "ERA\t/usr/bin/era",
        "UV\t/home/x/.local/bin/uv",
        "UVERA\t/home/x/.local/bin/era",
        "PY\t/usr/bin/python3\t3.12.8 final",
        "SRC\t/home/x/era-evolve",
      ].join("\n"),
    );
    expect(p.eraOnPath).toEqual(["/usr/bin/era"]);
    expect(p.eraFromUv).toEqual(["/home/x/.local/bin/era"]);
    expect(p.uv).toBe("/home/x/.local/bin/uv");
    expect(p.sources).toEqual(["/home/x/era-evolve"]);
    expect(p.pythons).toEqual([{ path: "/usr/bin/python3", version: [3, 12, 8], releaseLevel: "final" }]);
  });

  it("keeps paths that contain spaces", () => {
    const p = parseProbe("PY\t/c/Program Files/Python312/python.exe\t3.12.1 final");
    expect(p.pythons[0].path).toBe("/c/Program Files/Python312/python.exe");
  });

  it("drops the same interpreter reached by two routes", () => {
    const p = parseProbe(["PY\t" + PY + "\t3.12.8 final", "PY\t" + PY + "\t3.12.8 final"].join("\n"));
    expect(p.pythons).toHaveLength(1);
  });

  it("ignores junk lines instead of throwing", () => {
    const p = parseProbe(["", "hello", "PY\tbroken", "PY\t/x\tnot.a.version final"].join("\n"));
    expect(p.pythons).toEqual([]);
  });
});

describe("usablePythons", () => {
  const probe = (...lines: string[]) => parseProbe(lines.join("\n"));

  it("rejects 2.x — the trap this whole file exists for", () => {
    const p = probe("PY\t/c/Python27/python.exe\t2.7.10 final");
    expect(usablePythons(p)).toEqual([]);
  });

  it("rejects anything below 3.10", () => {
    expect(usablePythons(probe("PY\t/a\t3.9.18 final"))).toEqual([]);
    expect(usablePythons(probe("PY\t/a\t3.10.0 final"))).toHaveLength(1);
  });

  it("rejects prereleases", () => {
    // The machine this was written on offers a 3.10.0a5 with a broken pip as
    // its best `py -0p` entry; taking it would be worse than finding nothing.
    expect(usablePythons(probe("PY\t/a\t3.10.0 alpha"))).toEqual([]);
  });

  it("prefers the highest version", () => {
    const p = probe("PY\t/a\t3.10.4 final", "PY\t/b\t3.13.1 final", "PY\t/c\t3.12.8 final");
    expect(usablePythons(p).map((x) => x.path)).toEqual(["/b", "/c", "/a"]);
  });
});

describe("formatPython", () => {
  it("marks a prerelease", () => {
    expect(formatPython({ path: "/a", version: [3, 12, 8], releaseLevel: "final" })).toBe("3.12.8");
    expect(formatPython({ path: "/a", version: [3, 10, 0], releaseLevel: "alpha" })).toBe("3.10.0a");
  });
});

describe("withPython", () => {
  it("replaces a bare interpreter with the resolved one", () => {
    expect(withPython("python eval.py", PY)).toBe(`'${PY}' eval.py`);
    expect(withPython("python3 eval.py --fast", PY)).toBe(`'${PY}' eval.py --fast`);
    expect(withPython("py -3 eval.py", PY)).toBe(`'${PY}' -3 eval.py`);
  });

  it("leaves a path the user chose alone", () => {
    expect(withPython("/usr/bin/python3 eval.py", PY)).toBe("/usr/bin/python3 eval.py");
    expect(withPython("'C:/x/python.exe' eval.py", PY)).toBe("'C:/x/python.exe' eval.py");
  });

  it("leaves non-python evals alone", () => {
    expect(withPython("node score.js", PY)).toBe("node score.js");
    expect(withPython("bash run.sh", PY)).toBe("bash run.sh");
    expect(withPython("./eval.sh", PY)).toBe("./eval.sh");
  });

  it("is a no-op when nothing was found", () => {
    expect(withPython("python eval.py", null)).toBe("python eval.py");
  });

  it("escapes a path with a quote in it", () => {
    expect(withPython("python eval.py", "/a'b/python")).toBe(`'/a'\\''b/python' eval.py`);
  });

  it("preserves leading whitespace-free tails exactly", () => {
    expect(withPython("python", PY)).toBe(`'${PY}'`);
  });
});

describe("rewritesPython", () => {
  it("reports whether the eval starts with a bare interpreter", () => {
    expect(rewritesPython("python eval.py")).toBe(true);
    expect(rewritesPython("  python.exe eval.py")).toBe(true);
    expect(rewritesPython("node x.js")).toBe(false);
    expect(rewritesPython("/usr/bin/python3 eval.py")).toBe(false);
  });
});
