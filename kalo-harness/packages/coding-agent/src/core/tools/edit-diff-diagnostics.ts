/**
 * Closest-match diagnostics for failed exact-text edits.
 *
 * These helpers only run on the failure path. They are pure string operations:
 * no filesystem access, no exceptions, so a failed edit always reports the
 * original error even when a diagnostic cannot be computed.
 */

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			// Strip trailing whitespace per line
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

/** First line of the closest matching window that differs from the old text. */
export interface ClosestMatchDifference {
	/** 1-based line number in the file (may be past the end of the file). */
	line: number;
	/** The file line, or undefined when the file has no line at this position. */
	fileLine: string | undefined;
	/** The corresponding old text line. */
	oldTextLine: string;
	/** Trailing characters the old text has but the file line does not. */
	extraInOldText?: string;
	/** Trailing characters the file line has but the old text does not. */
	extraInFile?: string;
}

/** Where the old text nearly matched, and why it did not match exactly. */
export interface ClosestMatchDiagnostic {
	/** 1-based first line of the closest matching window. */
	startLine: number;
	/** 1-based last line of the closest matching window (clamped to the file). */
	endLine: number;
	/** 0..1 average per-line similarity between the window and the old text. */
	similarity: number;
	/** Number of lines in the old text. */
	oldTextLines: number;
	/** First line that does not match, if any. */
	difference?: ClosestMatchDifference;
}

const PREVIEW_MAX_CHARS = 160;
const PREVIEW_HEAD_CHARS = 96;
const PREVIEW_TAIL_CHARS = 60;
const FULL_SCAN_FILE_LINES = 1000;
const FULL_SCAN_OLD_LINES = 200;
const ANCHOR_LINES = 3;
const ANCHOR_CANDIDATES = 8;
const ANCHOR_MIN_SIMILARITY = 0.4;
const ANCHOR_DRIFT = 2;

/** Split into editor-visible lines: no trailing empty entry from a final newline. */
function splitLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

/** Similarity of two already-normalized lines: shared prefix + shared suffix. */
function lineSimilarity(fileLine: string, oldTextLine: string): number {
	if (fileLine === oldTextLine) {
		return 1;
	}
	const limit = Math.min(fileLine.length, oldTextLine.length);
	const maxLength = Math.max(fileLine.length, oldTextLine.length);
	if (maxLength === 0) {
		return 1;
	}
	let prefix = 0;
	while (prefix < limit && fileLine[prefix] === oldTextLine[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix < limit - prefix &&
		fileLine[fileLine.length - 1 - suffix] === oldTextLine[oldTextLine.length - 1 - suffix]
	) {
		suffix++;
	}
	return (prefix + suffix) / maxLength;
}

function scoreWindow(fileLines: string[], oldTextLines: string[], start: number): number {
	let total = 0;
	for (let index = 0; index < oldTextLines.length; index++) {
		const fileLine = fileLines[start + index];
		total += fileLine === undefined ? 0 : lineSimilarity(fileLine, oldTextLines[index]);
	}
	return total / oldTextLines.length;
}

function clampStart(start: number, fileLineCount: number): number {
	return Math.max(0, Math.min(start, fileLineCount - 1));
}

/**
 * Candidate window starts. Small inputs get an exhaustive scan; large files
 * fall back to anchoring on the longest old text lines and drifting by a couple
 * of lines, which keeps the diagnostics bounded on huge files.
 */
function candidateStarts(fileLines: string[], oldTextLines: string[]): number[] {
	const fileLineCount = fileLines.length;
	if (fileLineCount <= FULL_SCAN_FILE_LINES && oldTextLines.length <= FULL_SCAN_OLD_LINES) {
		return Array.from({ length: fileLineCount }, (_, index) => index);
	}

	const anchorIndices = oldTextLines
		.map((line, index) => ({ index, length: line.length }))
		.sort((a, b) => b.length - a.length || a.index - b.index)
		.slice(0, ANCHOR_LINES)
		.map((anchor) => anchor.index);

	const starts = new Set<number>([0]);
	for (const anchorIndex of anchorIndices) {
		const scored = fileLines
			.map((line, index) => ({ index, similarity: lineSimilarity(line, oldTextLines[anchorIndex]) }))
			.sort((a, b) => b.similarity - a.similarity || a.index - b.index)
			.slice(0, ANCHOR_CANDIDATES);
		for (const candidate of scored) {
			if (candidate.similarity < ANCHOR_MIN_SIMILARITY) {
				break;
			}
			for (let drift = -ANCHOR_DRIFT; drift <= ANCHOR_DRIFT; drift++) {
				starts.add(clampStart(candidate.index - anchorIndex + drift, fileLineCount));
			}
		}
	}
	return [...starts].sort((a, b) => a - b);
}

function findFirstDifference(fileLines: string[], oldTextLines: string[], start: number): number {
	for (let index = 0; index < oldTextLines.length; index++) {
		const fileLine = fileLines[start + index];
		if (fileLine === undefined || fileLine !== oldTextLines[index]) {
			return index;
		}
	}
	return -1;
}

function buildDifference(
	fileLines: string[],
	oldTextLines: string[],
	fileNormalized: string[],
	oldTextNormalized: string[],
	start: number,
	differenceIndex: number,
): ClosestMatchDifference {
	const fileIndex = start + differenceIndex;
	const normalizedFileLine = fileNormalized[fileIndex];
	const normalizedOldTextLine = oldTextNormalized[differenceIndex];
	const difference: ClosestMatchDifference = {
		line: fileIndex + 1,
		fileLine: fileLines[fileIndex],
		oldTextLine: oldTextLines[differenceIndex],
	};
	if (normalizedFileLine !== undefined && normalizedFileLine !== normalizedOldTextLine) {
		if (normalizedOldTextLine.startsWith(normalizedFileLine)) {
			difference.extraInOldText = normalizedOldTextLine.slice(normalizedFileLine.length);
		} else if (normalizedFileLine.startsWith(normalizedOldTextLine)) {
			difference.extraInFile = normalizedFileLine.slice(normalizedOldTextLine.length);
		}
	}
	return difference;
}

/**
 * Describe where `oldText` nearly matched `content` and what differs. Returns
 * undefined when either side is empty or no window can be scored.
 */
export function describeClosestMatch(content: string, oldText: string): ClosestMatchDiagnostic | undefined {
	const fileLines = splitLines(content);
	const oldTextLines = splitLines(oldText);
	if (fileLines.length === 0 || oldTextLines.length === 0) {
		return undefined;
	}

	const fileNormalized = fileLines.map(normalizeForFuzzyMatch);
	const oldTextNormalized = oldTextLines.map(normalizeForFuzzyMatch);

	let bestStart = 0;
	let bestScore = -1;
	for (const start of candidateStarts(fileNormalized, oldTextNormalized)) {
		const score = scoreWindow(fileNormalized, oldTextNormalized, start);
		if (score > bestScore) {
			bestScore = score;
			bestStart = start;
		}
	}
	if (bestScore < 0) {
		return undefined;
	}

	const differenceIndex = findFirstDifference(fileNormalized, oldTextNormalized, bestStart);
	return {
		startLine: bestStart + 1,
		endLine: Math.min(bestStart + oldTextNormalized.length, fileNormalized.length),
		similarity: Math.min(1, bestScore),
		oldTextLines: oldTextNormalized.length,
		difference:
			differenceIndex === -1
				? undefined
				: buildDifference(fileLines, oldTextLines, fileNormalized, oldTextNormalized, bestStart, differenceIndex),
	};
}

function previewLine(line: string): string {
	if (line.length <= PREVIEW_MAX_CHARS) {
		return line;
	}
	return `${line.slice(0, PREVIEW_HEAD_CHARS)}…${line.slice(-PREVIEW_TAIL_CHARS)}`;
}

function describeExtraCharacters(label: string, characters: string, target: "file" | "old-text"): string {
	const count = characters.length;
	const noun = count === 1 ? "character" : "characters";
	if (target === "file") {
		const verb = count === 1 ? "that is" : "that are";
		return `${label} has ${count} extra trailing ${noun} ${verb} not in the file: ${JSON.stringify(characters)}.`;
	}
	return `${label} has ${count} extra trailing ${noun} that the oldText is missing: ${JSON.stringify(characters)}.`;
}

/** Render a diagnostic for appending to the edit tool's not-found error. */
export function formatClosestMatchDiagnostic(diagnostic: ClosestMatchDiagnostic): string {
	const window =
		diagnostic.startLine === diagnostic.endLine
			? `line ${diagnostic.startLine}`
			: `lines ${diagnostic.startLine}-${diagnostic.endLine}`;
	const lines = [`Closest match: ${window} (${Math.round(diagnostic.similarity * 100)}% similar).`];

	const difference = diagnostic.difference;
	if (difference) {
		const fileLine = difference.fileLine === undefined ? "(end of file)" : `\`${previewLine(difference.fileLine)}\``;
		lines.push(`  line ${difference.line} file   : ${fileLine}`);
		lines.push(`  line ${difference.line} oldText: \`${previewLine(difference.oldTextLine)}\``);
		if (difference.extraInOldText) {
			lines.push(describeExtraCharacters("The oldText line", difference.extraInOldText, "file"));
		} else if (difference.extraInFile) {
			lines.push(describeExtraCharacters("The file line", difference.extraInFile, "old-text"));
		}
	}

	lines.push(
		diagnostic.similarity < 0.5
			? "No closely matching region was found. Verify the path and re-read the file before retrying."
			: "Re-read the file with the read tool, then retry with text copied verbatim from the file.",
	);
	return lines.join("\n");
}
