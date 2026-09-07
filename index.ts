/**
 * pi-file-guard.ts — File modification approval extension
 *
 * Asks for confirmation before destructive operations (edit / write / dangerous
 * bash) with the same arrow-key select dialog used by pi's model picker:
 * Up/Down to move, Enter to confirm, Escape to cancel.
 *
 * Installation:
 *   - Project:  .pi/extensions/pi-file-guard.ts      (this project only)
 *   - Global:   ~/.pi/agent/extensions/pi-file-guard.ts (all projects)
 * Run /reload after changing the file.
 *
 * Usage:
 *   /pi-file-guard              Show current status
 *   /pi-file-guard on|off       Enable / disable interception
 *   /pi-file-guard edit|write|bash   Toggle gating for that tool
 *   /pi-file-guard reset        Reset "allow/deny for this session" memory
 *
 * Notes:
 *   - Menu choices: allow once / allow all this session / deny once /
 *     deny and stop asking this session
 *   - In non-interactive modes (-p / json, no UI), write/edit calls are
 *     blocked by default (fail-safe).
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const STATUS_ID = "pi-file-guard";

const MENU = [
	"Allow this one",
	"Allow all changes this session",
	"Deny this one",
	"Deny and stop asking this session",
] as const;
type Decision = (typeof MENU)[number] | undefined;

// Bash commands that require confirmation (all other bash commands pass through)
const DANGEROUS_BASH = [
	/\brm\s+(-[a-zA-Z]*r|-r[a-zA-Z]*|--recursive)/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b/i,
	/\b(dd|mkfs|fdisk|shred|wipefs)\b/i,
	/\bgit\s+(push|reset|clean|checkout)\s+(-f|--hard|--force)/i,
	/\bmv\b.+\b(dev|sys|proc)\b/i,
];

interface State {
	enabled: boolean;
	gateEdit: boolean;
	gateWrite: boolean;
	gateBash: boolean;
	// Session-level memory, reset on session_start
	sessionAllowAll: boolean;
	sessionBlockAll: boolean;
}

export default function (pi: ExtensionAPI) {
	const state: State = {
		enabled: true,
		gateEdit: true,
		gateWrite: true,
		gateBash: true,
		sessionAllowAll: false,
		sessionBlockAll: false,
	};

	function updateStatus(ctx: ExtensionContext) {
		if (!state.enabled) {
			ctx.ui.setStatus(STATUS_ID, undefined);
			return;
		}
		const gates: string[] = [];
		if (state.gateEdit) gates.push("edit");
		if (state.gateWrite) gates.push("write");
		if (state.gateBash) gates.push("bash");
		const extra = state.sessionBlockAll
			? " [blocked]"
			: state.sessionAllowAll
				? " [allowed]"
				: "";
		ctx.ui.setStatus(STATUS_ID, `guard: ask (${gates.join("/")})${extra}`);
	}

	// ---------- tools ----------

	pi.on("tool_call", async (event, ctx) => {
		if (!state.enabled) return undefined;

		let kind: "edit" | "write" | "bash" | undefined;
		let title: string | undefined;

		if (state.gateEdit && isToolCallEventType("edit", event)) {
			kind = "edit";
			const { path, edits } = event.input;
			const abs = resolve(ctx.cwd, path ?? "");
			const blocks = (edits ?? []).map((e) => diffBlock(e.oldText ?? "", e.newText ?? ""));
			title = [
				`PERMISSION REQUIRED - edit file ${path}`,
				existsSync(abs)
					? `(overwrite existing file, ${blocks.length} change${blocks.length === 1 ? "" : "s"})`
					: "(file does not exist, will be created)",
				"",
				blocks.join("\n\n"),
			].join("\n");
		} else if (state.gateWrite && isToolCallEventType("write", event)) {
			kind = "write";
			const { path, content } = event.input;
			const abs = resolve(ctx.cwd, path ?? "");
			const contentLines = (content ?? "").split("\n").length;
			title = [
				`PERMISSION REQUIRED - write file ${path}`,
				existsSync(abs)
					? `(overwrite existing file, ${contentLines} lines)`
					: `(new file, ${contentLines} lines)`,
				"",
				capLines(content ?? "", 20, 40),
			].join("\n");
		} else if (state.gateBash && isToolCallEventType("bash", event)) {
			const command = event.input.command ?? "";
			if (!DANGEROUS_BASH.some((p) => p.test(command))) return undefined;
			kind = "bash";
			title = ["PERMISSION REQUIRED - DANGEROUS COMMAND", "", capLines(command, 20, 40)].join("\n");
		}

		if (!kind || !title) return undefined;

		// Session memory first: "deny all" → silently block
		if (state.sessionBlockAll) {
			return { block: true, reason: "User denied all changes for this session" };
		}
		// "allow all" → skip the prompt
		if (state.sessionAllowAll) return undefined;

		const decision = await ask(title, ctx, state);
		if (decision === "allow") return undefined;

		if (decision === "unset") {
			return { block: true, reason: "User cancelled the confirmation" };
		}
		if (decision === "deny") {
			ctx.ui.notify("Change denied", "warning");
			return { block: true, reason: "Denied by user" };
		}
		// deny-all
		state.sessionBlockAll = true;
		ctx.ui.notify("Denied - pi will not ask again this session", "warning");
		updateStatus(ctx);
		return { block: true, reason: "Denied by user (this session)" };
	});

	// ---------- state reset ----------

	pi.on("session_start", (_event, ctx) => {
		state.sessionAllowAll = false;
		state.sessionBlockAll = false;
		updateStatus(ctx);
	});

	// ---------- command ----------

	pi.registerCommand("pi-file-guard", {
		description: "File modification approval: on/off/status/edit/write/bash/reset",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			switch (arg) {
				case "on":
					state.enabled = true;
					break;
				case "off":
					state.enabled = false;
					break;
				case "edit":
					state.gateEdit = !state.gateEdit;
					break;
				case "write":
					state.gateWrite = !state.gateWrite;
					break;
				case "bash":
					state.gateBash = !state.gateBash;
					break;
				case "reset":
					state.sessionAllowAll = false;
					state.sessionBlockAll = false;
					break;
				default:
					break;
			}
			updateStatus(ctx);
			ctx.ui.notify(
				[
					`Status: ${state.enabled ? "enabled" : "disabled"}`,
					`  gating edit: ${state.gateEdit ? "yes" : "no"} | write: ${state.gateWrite ? "yes" : "no"} | dangerous bash: ${state.gateBash ? "yes" : "no"}`,
					`  session memory: ${state.sessionBlockAll ? "deny all" : state.sessionAllowAll ? "allow all" : "none"}`,
				].join("\n"),
				"info",
			);
		},
	});
}

// ---------- confirmation menu ----------

async function ask(
	title: string,
	ctx: ExtensionContext,
	state: State,
): Promise<"allow" | "deny" | "deny-all" | "unset"> {
	if (!ctx.hasUI) {
		// No UI (-p / json mode) - cannot prompt, fail-safe deny
		return "unset";
	}
	if (state.sessionAllowAll) return "allow";

	const prompt = `${stylePrompt(title, ctx.ui.theme)}\n\n${ctx.ui.theme.fg("warning", ctx.ui.theme.bold("Allow this operation?"))}`;
	const choice: Decision = await ctx.ui.select(prompt, [...MENU]);

	switch (choice) {
		case "Allow this one":
			return "allow";
		case "Allow all changes this session":
			state.sessionAllowAll = true;
			return "allow";
		case "Deny this one":
			return "deny";
		case "Deny and stop asking this session":
			return "deny-all";
		default: // Escape
			return "unset";
	}
}

// ---------- prompt styling (static ANSI colors, no animation) ----------

/**
 * Style C: title line in warning yellow bold, diff lines in their own
 * colors, everything else in the normal text color. The resulting string
 * carries inline ANSI codes, which override the select dialog's built-in
 * accent styling; it renders only in the terminal and never reaches the LLM.
 */
function stylePrompt(title: string, theme: Theme): string {
	const warn = (s: string) => theme.fg("warning", theme.bold(s));
	return title
		.split("\n")
		.map((line, i) => {
			if (!line) return line;
			if (i === 0) return warn(line);
			if (line.startsWith("  - ")) return theme.fg("toolDiffRemoved", line);
			if (line.startsWith("  + ")) return theme.fg("toolDiffAdded", line);
			if (line.startsWith("  ...") || line.startsWith("  ---")) return theme.fg("muted", line);
			return theme.fg("text", line);
		})
		.join("\n");
}

// ---------- preview helpers ----------

/** Truncate text: maxLines lines, maxCols chars per line */
function capLines(text: string, maxLines: number, maxCols: number): string {
	const lines = text.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		const l = line.length > maxCols ? `${line.slice(0, maxCols)}…` : line;
		out.push(l);
		if (out.length >= maxLines) break;
	}
	if (lines.length > out.length) out.push(`…(${lines.length - out.length} more lines omitted)`);
	return out.map((l) => `  ${l}`).join("\n");
}

/** Simple line-level diff preview (folded common prefix/suffix) */
function diffBlock(oldText: string, newText: string, maxLines = 14): string {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");

	let prefix = 0;
	while (
		prefix < oldLines.length &&
		prefix < newLines.length &&
		oldLines[prefix] === newLines[prefix]
	) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	) {
		suffix++;
	}

	const out: string[] = [];
	if (prefix > 0) out.push(`  ...${prefix} unchanged line${prefix === 1 ? "" : "s"}`);
	for (const l of oldLines.slice(prefix, oldLines.length - suffix)) out.push(`  - ${l}`);
	if (prefix < oldLines.length && prefix < newLines.length) out.push("  --------");
	for (const l of newLines.slice(prefix, newLines.length - suffix)) out.push(`  + ${l}`);
	if (suffix > 0) out.push(`  ...${suffix} unchanged line${suffix === 1 ? "" : "s"}`);

	if (out.length > maxLines) {
		const head = out.slice(0, maxLines - 1);
		const tail = out.slice(Math.max(maxLines - 1, out.length - 6));
		return [...head, `  ...(${out.length - head.length - tail.length} more lines omitted)`, ...tail].join("\n");
	}
	return out.join("\n");
}