/**
 * OMP's `orchestrate` magic-keyword boundary, reproduced locally so the plugin does not
 * import an internal module: no letter, digit, `_`, `.`, `/`, `\`, `-`, or `::` before the
 * word; no letter, digit, `_`, `/`, `\`, `-`, extension dot, or `(` after it. Case-sensitive.
 */
const ORCHESTRATE = /(?<![\p{L}\p{N}_./\\-])(?<!::)orchestrate(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()/u;

/** A line that opens or closes a fenced code block: up to 3 leading spaces, then 3+ backticks or tildes. */
const FENCE = /^( {0,3})([`~]{3,})/u;

/**
 * Blank every fenced block and matched inline-code span to spaces, keeping length and
 * newlines, the way OMP's `maskNonProse` does. A fence closes on a run of the same
 * character at least as long as the opener with nothing else on the line; an unclosed
 * fence masks to the end of the text.
 *
 * XML and HTML are deliberately not masked: agent briefs legitimately wrap prose in tags,
 * and masking them would silently disable the trigger for exactly those prompts.
 */
function maskCode(text: string): string {
	const n = text.length;
	const masked = new Uint8Array(n);

	let fenceChar = "";
	let fenceLen = 0;
	let lineStart = 0;
	while (lineStart <= n) {
		let nl = text.indexOf("\n", lineStart);
		if (nl < 0) nl = n;
		const line = text.slice(lineStart, nl);
		const open = FENCE.exec(line);
		if (fenceChar !== "") {
			for (let p = lineStart; p < nl; p++) masked[p] = 1;
			if (
				open !== null &&
				open[2]?.[0] === fenceChar &&
				open[2].length >= fenceLen &&
				line.slice(open[1]!.length + open[2].length).trim() === ""
			) {
				fenceChar = "";
				fenceLen = 0;
			}
		} else if (open !== null) {
			const marker = open[2]!;
			const ch = marker[0]!;
			// A backtick fence's info string may not contain a backtick.
			if (!(ch === "`" && line.slice(open[1]!.length + marker.length).includes("`"))) {
				fenceChar = ch;
				fenceLen = marker.length;
				for (let p = lineStart; p < nl; p++) masked[p] = 1;
			}
		}
		if (nl === n) break;
		lineStart = nl + 1;
	}

	// Inline code: a backtick run closed by an equal-length run on the same or a later line.
	let i = 0;
	while (i < n) {
		if (masked[i] === 1 || text[i] !== "`") {
			i++;
			continue;
		}
		let runEnd = i;
		while (runEnd < n && text[runEnd] === "`") runEnd++;
		const runLen = runEnd - i;
		let close = -1;
		let k = runEnd;
		while (k < n) {
			if (masked[k] === 1 || text[k] !== "`") {
				k++;
				continue;
			}
			let end = k;
			while (end < n && text[end] === "`") end++;
			if (end - k === runLen) {
				close = end;
				break;
			}
			k = end;
		}
		if (close < 0) {
			i = runEnd;
			continue;
		}
		for (let p = i; p < close; p++) masked[p] = 1;
		i = close;
	}

	let out = "";
	for (let p = 0; p < n; p++) out += masked[p] === 1 && text[p] !== "\n" ? " " : text[p];
	return out;
}

/** True when the standalone lowercase keyword appears outside code fences and inline code. */
export function mentionsOrchestrate(text: string): boolean {
	if (text.trim().length === 0) return false;
	if (!text.includes("`") && !text.includes("~~~")) return ORCHESTRATE.test(text);
	return ORCHESTRATE.test(maskCode(text));
}
