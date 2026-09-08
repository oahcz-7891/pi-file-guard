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
	// New-file creation commands (also ask before creating a new file)
	/\b(touch|mkdir|mktemp)\b/i,
	/\bnew-item\b/i,
	/\b(tee|printf|echo|cat)\b.+(>>|>)\s+\S+/i,
];

// 安静配色 (calm) —— 硬编码 ANSI 24-bit 真彩色，强制朴素色，不随终端主题变化。
// 只在“鲜艳”的语义色上用固定值；灰(muted)仍沿用终端主题。
const C_WARN  = "\x1b[1;38;2;198;163;90m";  // 警告黄 #c6a35a（含粗体）
const C_DEL   = "\x1b[38;2;194;112;111m";    // 危险操作 / edit 删行 红 #c2706f
const C_ADD   = "\x1b[38;2;130;170;123m";    // 新增(写入) 绿 #82aa7b
const C_RESET = "\x1b[0m";

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

		const decision = await ask(title, kind, ctx, state);
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
	kind: "edit" | "write" | "bash",
	ctx: ExtensionContext,
	state: State,
): Promise<"allow" | "deny" | "deny-all" | "unset"> {
	if (!ctx.hasUI) {
		// No UI (-p / json mode) - cannot prompt, fail-safe deny
		return "unset";
	}
	if (state.sessionAllowAll) return "allow";

	// Manual bold: theme.bold() uses chalk, which is level-0 inside pi's
	// extension runtime (no TTY), so bold styles never render.
	const warn = (s: string) => `${C_WARN}${s}${C_RESET}`;
	const prompt = `${stylePrompt(title, ctx.ui.theme, kind)}\n\n${warn("Allow this operation?")}`;
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
 * 安静配色 (calm)：标题/问题行、write 内容预览、bash 危险命令用固定 ANSI 色
 * （黄 #c6a35a / 绿 #82aa7b），edit 差异行用红 #c2706f 绿 #82aa7b；
 * meta 及 diff 上下文仍沿用主题 muted 灰。着色按 tool 类型判断，避免被
 * "- " / "+ " 前缀误判。字符串带内联 ANSI 码，覆盖 select 弹窗自带 accent，
 * 只在终端渲染，不进入 LLM。
 */
function stylePrompt(title: string, theme: Theme, kind: "edit" | "write" | "bash"): string {
	const warn = (s: string) => `${C_WARN}${s}${C_RESET}`;
	const muted = (s: string) => theme.fg("muted", s);
	const diffRemoved = (s: string) => `${C_DEL}${s}${C_RESET}`;
	const diffAdded = (s: string) => `${C_ADD}${s}${C_RESET}`;
	return title
		.split("\n")
		.map((line, i) => {
			if (!line) return line;
			if (i === 0) return warn(line);
			if (kind === "edit") {
				if (line.startsWith("  - ")) return diffRemoved(line);
				if (line.startsWith("  + ")) return diffAdded(line);
				return muted(line);
			}
			// bash: highlight the whole command line in warning yellow
			if (kind === "bash") return warn(line);
			// write: quiet muted content preview
			return muted(line);
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