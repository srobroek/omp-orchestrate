/**
 * Slash-command notices that survive `omp -p`.
 *
 * Measured (campaign item 345.5): `/orchestrate-status` under `omp -p` printed nothing.
 * Print mode initialises the extension runner with OMP's no-op UI context, whose
 * `notify` is `() => {}`, so every `ctx.ui.notify` a command handler makes is dropped
 * on the floor and the operator reads an empty stdout. The same no-op context is what an
 * in-process subagent gets, and `ctx.mode` is `"print"` for both, so `hasUI` alone cannot
 * tell the headless top-level session from a worker whose stdout is the lead's terminal.
 * The worker carries the hidden `yield` tool (`sessionRole`); the top-level session does not.
 *
 * So: always `ctx.ui.notify`, and when no UI is attached and this is the top-level
 * session, also write the text where the operator is reading. Text print mode owns
 * stdout for the answer, so the notice goes there; `--mode json` streams JSONL on stdout,
 * so a plain line would corrupt it and the notice goes to stderr, where OMP already
 * writes its own print-mode notes.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { sessionRole } from "../identity";

/** Notification level; `warning` wins over `info`, `error` over both. */
export type NoticeLevel = "info" | "warning" | "error";

/** What the helper reads of a command context. */
export type NoticeContext = Pick<ExtensionContext, "ui" | "hasUI" | "mode">;

/** Show `text` to the operator: the UI when one is attached, else the process's own output. */
export function commandNotice(pi: ExtensionAPI, ctx: NoticeContext, text: string, level: NoticeLevel): void {
	ctx.ui.notify(text, level);
	if (ctx.hasUI !== false || sessionRole(pi) === "worker") return;
	const stream = ctx.mode === "json" ? process.stderr : process.stdout;
	stream.write(`${level === "info" ? "" : `${level}: `}${text}\n`);
}
