"""Deterministic TSP scoring harness.

Imports ``solve(points)`` from solution.py and runs it on a set of fixed
Euclidean TSP instances.  Score = -(mean tour length), so bigger is better and
there is a lot of head-room between a trivial answer and a good heuristic
(roughly: identity order ~ -32900, nearest-neighbour ~ -6900, and local search
on top of that does better still).

Everything is stdlib-only and deterministic: the instances come from an LCG
with a fixed seed, and ``random`` is re-seeded before every call, so the same
solution.py always yields the same score.

Anti-tampering: the candidate module is imported and called with stdout
redirected into a buffer, and the verdict is written straight to the stdout
stream captured *before* the import, bypassing ``print``.  A candidate
therefore cannot emit a fake final line, hijack ``builtins.print``, or drown
the score in noise.

The last line of stdout is the authoritative score.
"""

import contextlib
import importlib.util
import io
import math
import os
import random
import sys
import time

NUM_INSTANCES = 8
NUM_CITIES = 60
COORD_RANGE = 1000.0
LCG_SEED = 20260807

# Total wall-clock budget for all instances together.  Generous on purpose: it
# exists to reject brute force, not to make tuning the constant the task.
TIME_CAP_S = 20.0

WORST = -1.0e9

# Grabbed before any candidate code runs; all output goes here, never through
# ``print`` (which the candidate could rebind at import time).
REAL_STDOUT = sys.stdout


def say(text):
    REAL_STDOUT.write(text + "\n")


def make_instances():
    """Fixed instances from a self-contained LCG (no dependency on `random`)."""
    state = LCG_SEED
    instances = []
    for _ in range(NUM_INSTANCES):
        points = []
        for _ in range(NUM_CITIES):
            state = (1103515245 * state + 12345) % (2 ** 31)
            x = state / (2 ** 31) * COORD_RANGE
            state = (1103515245 * state + 12345) % (2 ** 31)
            y = state / (2 ** 31) * COORD_RANGE
            points.append((x, y))
        instances.append(points)
    return instances


def tour_length(points, order):
    total = 0.0
    for i in range(len(order)):
        ax, ay = points[order[i]]
        bx, by = points[order[(i + 1) % len(order)]]
        total += math.hypot(ax - bx, ay - by)
    return total


def check_tour(order, n):
    """A tour must be a permutation of all city indices."""
    if not isinstance(order, (list, tuple)):
        return f"solve must return a list/tuple, got {type(order).__name__}"
    if len(order) != n:
        return f"tour has {len(order)} cities, expected {n}"
    try:
        as_ints = [int(i) for i in order]
    except (TypeError, ValueError):
        return "tour contains non-integer entries"
    if sorted(as_ints) != list(range(n)):
        return "tour is not a permutation of 0..n-1"
    return None


def load_solve():
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "solution.py")
    spec = importlib.util.spec_from_file_location("solution", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.solve


def run():
    sink = io.StringIO()
    with contextlib.redirect_stdout(sink):
        try:
            solve = load_solve()
        except Exception as exc:  # noqa: BLE001
            return f"IMPORT ERROR: {exc!r}", WORST

        instances = make_instances()
        lengths = []
        started = time.perf_counter()

        for idx, points in enumerate(instances):
            # Re-seed so a solution that uses `random` is still deterministic.
            random.seed(12345 + idx)
            try:
                order = solve([tuple(p) for p in points])
            except Exception as exc:  # noqa: BLE001
                return f"instance {idx}: solve raised {exc!r}", WORST
            problem = check_tour(order, len(points))
            if problem:
                return f"instance {idx}: invalid tour - {problem}", WORST
            lengths.append(tour_length(points, [int(i) for i in order]))

        elapsed = time.perf_counter() - started

    if elapsed > TIME_CAP_S:
        return f"TIME CAP EXCEEDED: {elapsed:.2f}s > {TIME_CAP_S:.2f}s", WORST

    mean = sum(lengths) / len(lengths)
    return (
        f"instances={len(lengths)} cities={NUM_CITIES} "
        f"mean_len={mean:.3f} best_inst={min(lengths):.1f} "
        f"worst_inst={max(lengths):.1f} elapsed={elapsed:.3f}s cap={TIME_CAP_S:.1f}s",
        -mean,
    )


def main():
    diagnostics, score = run()
    # Diagnostics for the mutation operator; the final line is the score.
    say(diagnostics)
    say(f"{score:.6f}")
    REAL_STDOUT.flush()


if __name__ == "__main__":
    main()
