/**
 * Tolerance strategies for locating `oldText` inside a file.
 *
 * Strategies are ordered from strictest to loosest. The caller tries them in
 * order and accepts the first one that can locate every edit of the call
 * (uniquely, so a looser strategy can never silently pick one of several
 * candidates).
 *
 * Line-count-preserving normalization only: callers rely on unchanged lines
 * coming back byte-identical from the original content.
 */

import { normalizeForFuzzyMatch } from "./edit-diff-diagnostics.ts";

/** Matching strategy that located an edit. */
export type EditMatchStrategy = "exact" | "fuzzy" | "trimmed" | "whitespace" | "anchored";

/** Ordered from the least to the most tolerant strategy. */
export const EDIT_MATCH_STRATEGIES: readonly EditMatchStrategy[] = [
	"exact",
	"fuzzy",
	"trimmed",
	"whitespace",
	"anchored",
];

/** Outcome of locating one edit in a normalized matching space. */
export type EditMatchLocation =
	| { kind: "match"; index: number; length: number }
	| { kind: "ambiguous"; occurrences: number }
	| { kind: "none" };

/** Per-line `trim()`: tolerates indentation and whitespace-style differences. */
export function normalizeForTrimMatch(text: string): string {
	return normalizeForFuzzyMatch(text)
		.split("\n")
		.map((line) => line.trim())
		.join("\n");
}

/** Collapses runs of spaces and tabs inside each line to a single space. */
export function normalizeForWhitespaceMatch(text: string): string {
	return normalizeForTrimMatch(text)
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " "))
		.join("\n");
}

/** Normalize file content and old text into the space used by a strategy. */
export function normalizeForStrategy(strategy: EditMatchStrategy, text: string): string {
	switch (strategy) {
		case "exact":
			return text;
		case "fuzzy":
			return normalizeForFuzzyMatch(text);
		case "trimmed":
		case "anchored":
			return normalizeForTrimMatch(text);
		case "whitespace":
			return normalizeForWhitespaceMatch(text);
	}
}

/** Locate one edit inside the already-normalized content of its strategy. */
export function locateWithStrategy(strategy: EditMatchStrategy, content: string, oldText: string): EditMatchLocation {
	switch (strategy) {
		case "exact":
		case "fuzzy":
			return locateSubstring(content, oldText);
		case "trimmed":
		case "whitespace":
			return locateWholeLineBlock(content, oldText);
		case "anchored":
			return locateAnchoredBlock(content, oldText);
	}
}

interface LogicalLine {
	text: string;
	start: number;
	/** Offset after the line's content, excluding its newline. */
	end: number;
}

interface LogicalLines {
	lines: LogicalLine[];
	endsWithNewline: boolean;
}

/** Split into editor-visible lines plus their offsets, without the trailing newline artifact. */
function splitLogicalLines(text: string): LogicalLines {
	const endsWithNewline = text.endsWith("\n");
	const raw = text.split("\n");
	if (endsWithNewline) {
		raw.pop();
	}
	const lines: LogicalLine[] = [];
	let offset = 0;
	for (const line of raw) {
		lines.push({ text: line, start: offset, end: offset + line.length });
		offset += line.length + 1;
	}
	return { lines, endsWithNewline };
}

/** Match a whole line block, so rewritten lines are always covered end to end. */
function locateWholeLineBlock(content: string, oldText: string): EditMatchLocation {
	const contentLines = splitLogicalLines(content);
	const blockLines = splitLogicalLines(oldText);
	const count = blockLines.lines.length;
	if (count === 0 || count > contentLines.lines.length) {
		return { kind: "none" };
	}

	const starts: number[] = [];
	for (let start = 0; start + count <= contentLines.lines.length; start++) {
		let matched = true;
		for (let offset = 0; offset < count; offset++) {
			if (contentLines.lines[start + offset].text !== blockLines.lines[offset].text) {
				matched = false;
				break;
			}
		}
		if (matched) {
			starts.push(start);
		}
	}

	if (starts.length === 0) {
		return { kind: "none" };
	}
	if (starts.length > 1) {
		return { kind: "ambiguous", occurrences: starts.length };
	}
	return lineBlockLocation(contentLines, starts[0], count, blockLines.endsWithNewline ? content.length : undefined);
}

/**
 * Match a multi-line block by anchoring on its first and last line and scoring
 * the middle with an LCS ratio. Used when the middle drifted too much for the
 * line block strategies.
 */
function locateAnchoredBlock(content: string, oldText: string): EditMatchLocation {
	const contentLines = splitLogicalLines(content);
	const blockLines = splitLogicalLines(oldText);
	const count = blockLines.lines.length;
	if (count < 3 || count > contentLines.lines.length) {
		return { kind: "none" };
	}

	const firstLine = blockLines.lines[0].text;
	const lastLine = blockLines.lines[count - 1].text;
	if (firstLine === "" || lastLine === "") {
		return { kind: "none" };
	}

	const candidates: number[] = [];
	for (let start = 0; start + count <= contentLines.lines.length; start++) {
		if (contentLines.lines[start].text === firstLine && contentLines.lines[start + count - 1].text === lastLine) {
			candidates.push(start);
		}
	}
	if (candidates.length === 0) {
		return { kind: "none" };
	}

	const threshold = candidates.length === 1 ? 0.5 : 0.7;
	const blockMiddle = blockLines.lines
		.slice(1, count - 1)
		.map((line) => line.text)
		.join("\n");
	const passing = candidates.filter((start) => {
		const contentMiddle = contentLines.lines
			.slice(start + 1, start + count - 1)
			.map((line) => line.text)
			.join("\n");
		return lcsRatio(contentMiddle, blockMiddle) >= threshold;
	});

	if (passing.length === 0) {
		return { kind: "none" };
	}
	if (passing.length > 1) {
		return { kind: "ambiguous", occurrences: passing.length };
	}
	return lineBlockLocation(contentLines, passing[0], count, blockLines.endsWithNewline ? content.length : undefined);
}

function lineBlockLocation(
	contentLines: LogicalLines,
	startLine: number,
	lineCount: number,
	contentLength: number | undefined,
): EditMatchLocation {
	const start = contentLines.lines[startLine].start;
	const lastLine = contentLines.lines[startLine + lineCount - 1];
	// Include the trailing newline only when the old text ends with one and the
	// file actually has one after this line.
	const end = contentLength === undefined ? lastLine.end : Math.min(lastLine.end + 1, contentLength);
	return { kind: "match", index: start, length: end - start };
}

function locateSubstring(content: string, oldText: string): EditMatchLocation {
	if (oldText.length === 0) {
		return content.length === 0
			? { kind: "match", index: 0, length: 0 }
			: { kind: "ambiguous", occurrences: content.length + 1 };
	}
	const index = content.indexOf(oldText);
	if (index === -1) {
		return { kind: "none" };
	}
	const occurrences = content.split(oldText).length - 1;
	if (occurrences > 1) {
		return { kind: "ambiguous", occurrences };
	}
	return { kind: "match", index, length: oldText.length };
}

/**
 * Character-level LCS similarity, `2·LCS/(|a|+|b|)`. Inputs above the cap fall
 * back to an equality check to keep the anchored strategy from stalling on huge
 * blocks.
 */
function lcsRatio(a: string, b: string): number {
	if (a.length === 0 && b.length === 0) {
		return 1;
	}
	if (a.length === 0 || b.length === 0) {
		return 0;
	}
	const cap = 4000;
	if (a.length > cap || b.length > cap) {
		return a === b ? 1 : 0;
	}

	const rows = a.length;
	const columns = b.length;
	let previous = new Array<number>(columns + 1).fill(0);
	for (let row = 1; row <= rows; row++) {
		const current = new Array<number>(columns + 1).fill(0);
		for (let column = 1; column <= columns; column++) {
			current[column] =
				a[row - 1] === b[column - 1] ? previous[column - 1] + 1 : Math.max(previous[column], current[column - 1]);
		}
		previous = current;
	}
	return (2 * previous[columns]) / (rows + columns);
}
