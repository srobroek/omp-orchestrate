/**
 * OMP's `orchestrate` magic-keyword boundary, reproduced locally so the plugin does not
 * import an internal module: no letter, digit, `_`, `.`, `/`, `\`, `-`, or `::` before the
 * word; no letter, digit, `_`, `/`, `\`, `-`, extension dot, or `(` after it. Case-sensitive.
 */
const ORCHESTRATE = /(?<![\p{L}\p{N}_./\\-])(?<!::)orchestrate(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()/u;

/** Fenced blocks (three or more backticks or tildes, closed by the same fence) and matched single-backtick spans. */
const FENCE = /^([`~]{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gmu;
const INLINE_CODE = /`[^`\n]+`/gu;

/**
 * True when the standalone lowercase keyword appears outside code fences and inline code.
 *
 * XML and HTML are deliberately not masked: agent briefs legitimately wrap prose in tags,
 * and masking them would silently disable the trigger for exactly those prompts.
 */
export function mentionsOrchestrate(text: string): boolean {
	if (text.trim().length === 0) return false;
	const masked = text
		.replace(FENCE, block => " ".repeat(block.length))
		.replace(INLINE_CODE, span => " ".repeat(span.length));
	return ORCHESTRATE.test(masked);
}
