/**
 * pi-file-guard.ts — File modification approval extension with a danger level dial
 *
 * Asks for confirmation before destructive operations (edit / write / dangerous
 * bash) with the same arrow-key select dialog used by pi's model picker:
 * Up/Down to move, Enter to confirm, Escape to cancel.
 *
 * Danger model (see danger-level-plan.md):
 *   - Every tool call is classified into a danger tier: 1 (catastrophic) ..
 *     4 (read-only).
 *   - The user picks a strictness level 0..4. An action is gated when
 *     `tier <= level`. Level 0 disables gating, level 2 (default) gates
 *     catastrophic + destructive bash, level 3 gates all edit/write plus
 *     dangerous bash, level 4 gates every tool call.
 *   - Paths outside ctx.cwd are one tier more dangerous than the same
 *     operation in-project, and keep their own session allow/deny memory
 *     ("allow all in-project" never whitelists out-of-project edits).
 *
 * The prompt body mimics Claude Code's permission UI:
 *   ● Update(path)          (green dot, bold tool name)
 *     ⚠ tier 2 · sensitive path · escalated from tier 3
 *     ⎿  Removed 1 line      (summary)
 *        11 - old line       (red background)
 *        11 + new line       (green background)
 *   Do you want to proceed?
 *
 * Installation:
 *   - Project:  .pi/extensions/pi-file-guard.ts      (this project only)
 *   - Global:   ~/.pi/agent/extensions/pi-file-guard.ts (all projects)
 * Run /reload after changing the file.
 *
 * Usage:
 *   /pi-file-guard                 Show current status
 *   /pi-file-guard level           Pick level 0-4 with arrow keys
 *   /pi-file-guard level 2         Set level directly
 *   /pi-file-guard 0|1|2|3|4       Set level directly
 *   /pi-file-guard +|-             Step strictness up / down
 *   /pi-file-guard on|off          Compat: resume last level / level 0
 *   /pi-file-guard edit|write|bash Mute (never gate) that tool
 *   /pi-file-guard reset           Reset "allow/deny for this session" memory
 *
 * Notes:
 *   - Menu choices: yes / yes+allow-all / no / no+stop-asking (this session)
 *   - In non-interactive modes (-p / json, no UI), gated calls are blocked
 *     by default (fail-safe).
 *   - The level is persisted per session via pi.appendEntry() and restored on
 *     session_start / session_tree. A project default can be placed in
 *     .pi/pi-file-guard.json as { "level": 3 }.
 *   - Colors are hard-coded 24-bit ANSI sampled from real Claude Code shots,
 *     so they stay stable regardless of the terminal theme. Layout limits of
 *     ctx.ui.select() are documented in claude-style-plan.md.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const STATUS_ID = "pi-file-guard";
const CONFIG_ENTRY = "pi-file-guard-config";

// ---------- Claude Code palette (sampled from real screenshots) ----------
// Hard-coded 24-bit ANSI so the semantic colors do not shift with the terminal
// theme. Values map onto the xterm-256 palette (#5f0000=52, #005f00=22,
// #87d787=114, #afd700=154), which keeps them stable across terminals.
const RESET = "\x1b[0m";
const S_HEADER = "\x1b[1;38;2;175;215;255m"; // #afd7ff — permission title
const S_GREEN = "\x1b[38;2;135;215;135m"; // #87d787 — ● / added
const S_WHITE = "\x1b[1;38;2;255;255;255m"; // emphasis
const S_TEXT = "\x1b[38;2;204;204;204m"; // #cccccc — body
const S_DIM = "\x1b[38;2;140;140;141m"; // #8c8c8d — paths, line numbers
const S_DEL = "\x1b[38;2;255;255;255;48;2;95;0;0m"; // white on #5f0000
const S_ADD = "\x1b[1;38;2;215;255;215;48;2;0;95;0m"; // #d7ffd7 on #005f00
// Danger tiers 1-3 (tier 4 reuses S_DIM).
const S_T1 = "\x1b[1;38;2;255;95;95m"; // #ff5f5f — catastrophic
const S_T2 = "\x1b[38;2;215;95;95m"; // #d75f5f — destructive
const S_T3 = "\x1b[38;2;215;175;95m"; // #d7af5f — modifying

const paint = (code: string, s: string) => `${code}${s}${RESET}`;

type Kind = "edit" | "write" | "bash" | "other";
type Decision = "allow" | "deny" | "deny-all" | "unset";
type Level = 0 | 1 | 2 | 3 | 4;
type Tier = 1 | 2 | 3 | 4;
/** Whether a target lives inside ctx.cwd. Each scope keeps its own memory. */
type Scope = "inside" | "outside";

/** A classified tool call: how dangerous it is and why. */
interface Verdict {
	tier: Tier;
	label: string;
	reasons?: string[];
	note?: string;
	scope?: Scope;
}

const LEVELS: { name: string; scope: string }[] = [
	{ name: "off", scope: "no confirmation" },
	{ name: "low", scope: "catastrophic only (sudo / dd / curl|sh)" },
	{ name: "medium", scope: "+ destructive (rm / mv / chmod / git --hard)" },
	{ name: "high", scope: "+ every edit, write and file creation" },
	{ name: "paranoid", scope: "+ every tool call (ls / read too)" },
];

const TIER_COLOR: Record<Tier, string> = { 1: S_T1, 2: S_T2, 3: S_T3, 4: S_DIM };
const TIER_NOTE: Record<Tier, string> = {
	1: "catastrophic & irreversible",
	2: "destructive",
	3: "modifies files",
	4: "read-only",
};

const clampLevel = (n: number): Level => Math.max(0, Math.min(4, Math.round(n))) as Level;

// ---------- bash danger rules ----------

interface DangerRule {
	re: RegExp;
	label: string;
	tier: Tier;
}

const DANGER_RULES: DangerRule[] = [
	// tier 1 — catastrophic / irreversible
	{ re: /\bsudo\b/i, label: "privilege escalation", tier: 1 },
	{ re: /\b(dd|mkfs|fdisk|shred|wipefs)\b/i, label: "raw disk operation", tier: 1 },
	{ re: /\brm\s+(-[a-zA-Z]*\s+)*\/(\s|$)/i, label: "delete root", tier: 1 },
	{ re: /(curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(sh|bash|zsh|iex|powershell)/i, label: "remote script execution", tier: 1 },
	{ re: /(>|>>)\s*\/dev\/(sd|nvme|disk)/i, label: "write to raw device", tier: 1 },
	{ re: /\bgit\s+push\b[^\n]*(--force|-f)\b[^\n]*\b(main|master)\b/i, label: "force push to main", tier: 1 },

	// tier 2 — destructive / hard to undo
	{ re: /\brm\b/i, label: "file deletion", tier: 2 },
	{ re: /\bmv\b/i, label: "file move", tier: 2 },
	{ re: /\b(chmod|chown)\b/i, label: "permission change", tier: 2 },
	{ re: /\bgit\s+(reset|clean|checkout)\b[^\n]*(-f|--hard|--force)/i, label: "destructive git operation", tier: 2 },
	{ re: /\bgit\s+push\b[^\n]*(--force|-f)/i, label: "force push", tier: 2 },
	{ re: /\bmv\b[^\n]*\b(dev|sys|proc)\b/i, label: "system path move", tier: 2 },
	{ re: /\b(npm|pnpm|yarn)\s+publish\b/i, label: "package publish", tier: 2 },

	// tier 3 — modifying
	{ re: /\b(touch|mkdir|mktemp)\b/i, label: "file creation", tier: 3 },
	{ re: /\bnew-item\b/i, label: "file creation", tier: 3 },
	{ re: /\b(tee|printf|echo|cat)\b[^\n]*(>>|>)\s*\S+/i, label: "output redirection", tier: 3 },
	{ re: /\b(npm|pnpm|yarn|bun|pip|pip3|apt|apt-get|brew|choco|winget|gem|cargo)\s+(install|add|upgrade|update)\b/i, label: "package install", tier: 3 },
	{ re: /\bgit\s+(commit|merge|rebase|cherry-pick|apply|am|revert)\b/i, label: "git write operation", tier: 3 },
];

// ---------- sensitive paths (escalate write/edit by one tier) ----------

const SENSITIVE_PATHS: { re: RegExp; label: string }[] = [
	{ re: /(^|\/)\.env(\.[^/]*)?$/i, label: ".env" },
	{ re: /(^|\/)\.git(\/|$)/i, label: ".git" },
	{ re: /(^|\/)\.ssh(\/|$)/i, label: ".ssh" },
	{ re: /(^|\/)id_rsa/i, label: "ssh key" },
	{ re: /\.(pem|key|pfx|p12)$/i, label: "key material" },
	{ re: /(^|\/)\.npmrc$/i, label: ".npmrc" },
	{ re: /(^|\/)package\.json$/i, label: "package.json" },
	{ re: /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i, label: "lockfile" },
	{ re: /(^|\/)dockerfile$/i, label: "Dockerfile" },
	{ re: /(^|\/)\.github\/workflows\//i, label: "CI workflow" },
	{ re: /(^|\/)\.pi\/settings\.json$/i, label: "pi settings" },
];

const READ_ONLY_TOOLS = new Set(["read", "glob", "grep", "list", "ls", "find", "search"]);

interface State {
	level: Level;
	lastNonZeroLevel: Level; // remembered for `on` / `off` compatibility
	mutedEdit: boolean; // "mute" means: never gate this tool, whatever the level
	mutedWrite: boolean;
	mutedBash: boolean;
	// Session-level memory, kept separate for inside vs outside ctx.cwd so
	// "allow all in-project" never silently whitelists out-of-project edits.
	allowAll: Record<Scope, boolean>;
	blockAll: Record<Scope, boolean>;
}

export default function (pi: ExtensionAPI) {
	const state: State = {
		level: 2,
		lastNonZeroLevel: 2,
		mutedEdit: false,
		mutedWrite: false,
		mutedBash: false,
		allowAll: { inside: false, outside: false },
		blockAll: { inside: false, outside: false },
	};

	function persist() {
		pi.appendEntry(CONFIG_ENTRY, {
			level: state.level,
			lastNonZeroLevel: state.lastNonZeroLevel,
			mutedEdit: state.mutedEdit,
			mutedWrite: state.mutedWrite,
			mutedBash: state.mutedBash,
		});
	}

	function setLevel(next: Level) {
		if (next === state.level) return;
		// Do not carry "allow all" from a looser level into a stricter one.
		state.allowAll = { inside: false, outside: false };
		state.blockAll = { inside: false, outside: false };
		if (next > 0) state.lastNonZeroLevel = next;
		state.level = next;
		persist();
	}

	function restore(ctx: ExtensionContext) {
		let saved: Partial<State> | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === CONFIG_ENTRY) {
				saved = entry.data as Partial<State>;
			}
		}
		if (saved) {
			state.level = clampLevel(Number(saved.level ?? 2));
			state.lastNonZeroLevel = clampLevel(Number(saved.lastNonZeroLevel ?? 2)) || 2;
			state.mutedEdit = !!saved.mutedEdit;
			state.mutedWrite = !!saved.mutedWrite;
			state.mutedBash = !!saved.mutedBash;
		} else {
			state.level = readProjectDefault(ctx.cwd) ?? 2;
			state.lastNonZeroLevel = state.level || 2;
		}
		state.allowAll = { inside: false, outside: false };
		state.blockAll = { inside: false, outside: false };
	}

	function updateStatus(ctx: ExtensionContext) {
		const blocked = state.blockAll.inside || state.blockAll.outside;
		const allowed = state.allowAll.inside || state.allowAll.outside;
		const extra = blocked ? " [blocked]" : allowed ? " [allowed]" : "";
		ctx.ui.setStatus(STATUS_ID, `guard: L${state.level} ${LEVELS[state.level].name}${extra}`);
	}

	// ---------- tools ----------

	pi.on("tool_call", async (event, ctx) => {
		if (state.level === 0) return undefined;

		let kind: Kind | undefined;
		let verdict: Verdict | undefined;
		let prompt: string | undefined;

		if (!state.mutedEdit && isToolCallEventType("edit", event)) {
			kind = "edit";
			const { path, edits } = event.input;
			const abs = resolve(ctx.cwd, path ?? "");
			verdict = classifyPath("edit", path ?? "", abs, ctx.cwd);
			if (verdict.tier <= state.level) prompt = buildEditPrompt(path ?? "", edits ?? [], abs, verdict);
		} else if (!state.mutedWrite && isToolCallEventType("write", event)) {
			kind = "write";
			const { path, content } = event.input;
			const abs = resolve(ctx.cwd, path ?? "");
			verdict = classifyPath("write", path ?? "", abs, ctx.cwd, content ?? "");
			if (verdict.tier <= state.level) prompt = buildWritePrompt(path ?? "", content ?? "", abs, verdict);
		} else if (!state.mutedBash && isToolCallEventType("bash", event)) {
			const command = event.input.command ?? "";
			verdict = classifyBash(command);
			if (verdict.tier <= state.level) {
				kind = "bash";
				prompt = buildBashPrompt(command, verdict);
			}
		} else if (state.level >= 4 && !isCoreTool(event.toolName)) {
			// Paranoid: gate every remaining tool (read / glob / custom tools...).
			kind = "other";
			verdict = { tier: 4, label: READ_ONLY_TOOLS.has(event.toolName) ? "read-only" : "tool call" };
			prompt = buildToolPrompt(event.toolName, briefInput(event.input), verdict);
		}

		if (!kind || !verdict || !prompt) return undefined;

		const scope = scopeOf(verdict);

		// Session memory first (per scope): "deny all" → silently block
		if (state.blockAll[scope]) {
			return { block: true, reason: "User denied all changes for this session" };
		}
		// "allow all" → skip the prompt
		if (state.allowAll[scope]) return undefined;

		const decision = await ask(prompt, kind, scope, ctx, state);
		if (decision === "allow") return undefined;

		if (decision === "unset") {
			return { block: true, reason: "User cancelled the confirmation" };
		}
		if (decision === "deny") {
			ctx.ui.notify("Change denied", "warning");
			return { block: true, reason: "Denied by user" };
		}
		// deny-all
		state.blockAll[scope] = true;
		ctx.ui.notify("Denied - pi will not ask again this session", "warning");
		updateStatus(ctx);
		return { block: true, reason: "Denied by user (this session)" };
	});

	// ---------- state reset / restore ----------

	pi.on("session_start", (_event, ctx) => {
		restore(ctx);
		updateStatus(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		restore(ctx);
		updateStatus(ctx);
	});

	// ---------- command ----------

	pi.registerCommand("pi-file-guard", {
		description: "Danger level: level [0-4|+|-] · on/off · edit/write/bash mute · reset",
		getArgumentCompletions: (prefix: string) => {
			const all = ["level", "0", "1", "2", "3", "4", "+", "-", "on", "off", "edit", "write", "bash", "reset"];
			const items = all.filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
			const arg = parts[0] ?? "";

			if (arg === "level") {
				const val = parts[1];
				if (!val) {
					const picked = await pickLevel(ctx);
					if (picked === undefined) return;
					setLevel(picked);
				} else {
					const n = Number(val);
					if (Number.isInteger(n) && n >= 0 && n <= 4) {
						setLevel(n as Level);
					} else {
						ctx.ui.notify("Level must be an integer 0-4", "warning");
						return;
					}
				}
			} else if (/^[0-4]$/.test(arg)) {
				setLevel(Number(arg) as Level);
			} else if (arg === "+" || arg === "-") {
				setLevel(clampLevel(state.level + (arg === "+" ? 1 : -1)));
			} else if (arg === "on") {
				setLevel(state.lastNonZeroLevel || 3);
			} else if (arg === "off") {
				setLevel(0);
			} else if (arg === "edit") {
				state.mutedEdit = !state.mutedEdit;
				persist();
			} else if (arg === "write") {
				state.mutedWrite = !state.mutedWrite;
				persist();
			} else if (arg === "bash") {
				state.mutedBash = !state.mutedBash;
				persist();
			} else if (arg === "reset") {
				state.allowAll = { inside: false, outside: false };
				state.blockAll = { inside: false, outside: false };
			}

			updateStatus(ctx);
			ctx.ui.notify(statusText(state), "info");
		},
	});
}

// ---------- classification ----------

/** Classify an edit/write target. Sensitive / outside-project paths escalate. */
function classifyPath(kind: Kind, path: string, abs: string, cwd: string, content = ""): Verdict {
	const exists = existsSync(abs);
	let tier: Tier;
	let label: string;
	if (kind === "edit") {
		tier = 3;
		label = exists ? "edit file" : "edit creates file";
	} else if (exists) {
		tier = 2;
		label = "overwrite existing file";
	} else {
		tier = 3;
		label = "create new file";
	}
	const base = tier;
	const reasons: string[] = [];
	const norm = path.replace(/\\/g, "/");
	for (const sp of SENSITIVE_PATHS) {
		if (sp.re.test(norm)) {
			reasons.push(sp.label);
			if (tier > 1) tier = (tier - 1) as Tier;
			break;
		}
	}
	const inside = isInside(cwd, abs);
	if (!inside) {
		// Outside the project root is one tier more dangerous than the same
		// operation in-project (tier 1 is the most dangerous).
		reasons.push("outside project");
		if (tier > 1) tier = (tier - 1) as Tier;
	}
	if (kind === "write" && content.split("\n").length > 200) reasons.push("large write");
	const note = tier < base ? `escalated from tier ${base}` : undefined;
	return { tier, label, reasons: reasons.length ? reasons : undefined, note, scope: inside ? "inside" : "outside" };
}

/** Bash and non-file tools belong to the in-project scope. */
function scopeOf(v: Verdict): Scope {
	return v.scope ?? "inside";
}

/** Classify a bash command; compound commands take the most dangerous segment. */
function classifyBash(command: string): Verdict {
	const cmd = command.trim();
	if (!cmd) return { tier: 4, label: "empty command" };

	const parts = new Set<string>([cmd]);
	for (const p of cmd.split(/\s*(?:&&|\|\||;|\n)\s*/)) if (p) parts.add(p);
	for (const p of cmd.split(/\s*\|\s*/)) if (p) parts.add(p);

	const matched: DangerRule[] = [];
	for (const part of parts) {
		for (const rule of DANGER_RULES) {
			if (rule.re.test(part) && !matched.includes(rule)) matched.push(rule);
		}
	}
	if (matched.length === 0) return { tier: 4, label: "shell command" };

	matched.sort((a, b) => a.tier - b.tier);
	const primary = matched[0];
	// Only surface additional reasons at the same (most dangerous) tier;
	// e.g. `sudo rm -rf /` should not also list the generic "file deletion".
	const reasons = matched
		.slice(1)
		.filter((r) => r.tier === primary.tier)
		.map((r) => r.label)
		.filter((l, i, arr) => l !== primary.label && arr.indexOf(l) === i);
	return { tier: primary.tier, label: primary.label, reasons: reasons.length ? reasons.slice(0, 2) : undefined };
}

function isInside(cwd: string, abs: string): boolean {
	const rel = relative(cwd, abs);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isCoreTool(name: string): boolean {
	return name === "edit" || name === "write" || name === "bash";
}

function readProjectDefault(cwd: string): Level | undefined {
	try {
		const file = resolve(cwd, ".pi", "pi-file-guard.json");
		if (!existsSync(file)) return undefined;
		const data = JSON.parse(readFileSync(file, "utf8")) as { level?: unknown };
		const n = Number(data?.level);
		if (Number.isInteger(n) && n >= 0 && n <= 4) return n as Level;
	} catch {
		// ignore malformed config
	}
	return undefined;
}

// ---------- confirmation menu ----------

/** Claude Code style wording; the option at each index maps to a decision. */
function menuFor(kind: Kind, scope: Scope): string[] {
	const noun =
		kind === "edit" ? "edits" : kind === "write" ? "writes" : kind === "bash" ? "bash commands" : "tool calls";
	const where = scope === "outside" ? "outside this project" : "in this project";
	return [
		"Yes",
		`Yes, and allow all ${noun} ${where} this session`,
		"No",
		`No, and stop asking for ${noun} ${where} this session`,
	];
}

async function ask(
	prompt: string,
	kind: Kind,
	scope: Scope,
	ctx: ExtensionContext,
	state: State,
): Promise<Decision> {
	if (!ctx.hasUI) {
		// No UI (-p / json mode) - cannot prompt, fail-safe deny
		return "unset";
	}

	const options = menuFor(kind, scope);
	const choice = await ctx.ui.select(prompt, options);
	const index = choice === undefined ? -1 : options.indexOf(choice);

	switch (index) {
		case 0:
			return "allow";
		case 1:
			state.allowAll[scope] = true;
			return "allow";
		case 2:
			return "deny";
		case 3:
			return "deny-all";
		default: // Escape
			return "unset";
	}
}

async function pickLevel(ctx: ExtensionContext): Promise<Level | undefined> {
	if (!ctx.hasUI) return undefined;
	const options = LEVELS.map((l, i) => `${i}  ${l.name}  —  ${l.scope}`);
	const choice = await ctx.ui.select("Danger level (higher = asks more often)", options);
	if (choice === undefined) return undefined;
	return clampLevel(options.indexOf(choice));
}

function statusText(state: State): string {
	const l = LEVELS[state.level];
	const mutes = [
		state.mutedEdit ? "edit" : "",
		state.mutedWrite ? "write" : "",
		state.mutedBash ? "bash" : "",
	].filter((x): x is string => x.length > 0);
	return [
		`Danger level: ${state.level} (${l.name})${state.level === 0 ? " · off" : ` — gates tier ≤ ${state.level}`}`,
		`  scope: ${l.scope}`,
		`  muted tools: ${mutes.length ? mutes.join(", ") : "none"}`,
		`  session memory: in-project ${memory(state, "inside")} · outside ${memory(state, "outside")}`,
	].join("\n");
}

function memory(state: State, scope: Scope): string {
	return state.blockAll[scope] ? "deny all" : state.allowAll[scope] ? "allow all" : "none";
}

// ---------- Claude-style prompt builders ----------

function toolHeader(name: string, arg: string): string {
	const tail = arg ? paint(S_TEXT, `(${arg})`) : "";
	return `${paint(S_GREEN, "●")} ${paint(S_WHITE, name)}${tail}`;
}

function connector(summary: string): string {
	return `  ${paint(S_DIM, "⎿")}  ${paint(S_WHITE, summary)}`;
}

function summarize(removed: number, added: number): string {
	const parts: string[] = [];
	if (removed > 0) parts.push(`Removed ${removed} line${removed === 1 ? "" : "s"}`);
	if (added > 0) parts.push(`Added ${added} line${added === 1 ? "" : "s"}`);
	return parts.length ? parts.join(", ") : "No changes";
}

/** One-line danger banner: `⚠ tier 2 · recursive delete · destructive`. */
function dangerLine(v: Verdict): string {
	const color = TIER_COLOR[v.tier];
	const ico = v.tier === 4 ? "·" : "⚠";
	const main = [`${ico} tier ${v.tier}`, v.label, ...(v.reasons ?? [])].join(" · ");
	return paint(color, main) + paint(S_DIM, ` · ${v.note ?? TIER_NOTE[v.tier]}`);
}

function buildBashPrompt(command: string, verdict: Verdict): string {
	const lines = [paint(S_HEADER, "Bash command")];
	for (const l of clip(command, 6, 100)) lines.push(`  ${paint(S_TEXT, l)}`);
	lines.push("");
	lines.push(dangerLine(verdict));
	lines.push("");
	lines.push(paint(S_WHITE, "Do you want to proceed?"));
	return lines.join("\n");
}

interface EditInput {
	oldText?: string;
	newText?: string;
}

function buildEditPrompt(path: string, edits: EditInput[], abs: string, verdict: Verdict): string {
	const exists = existsSync(abs);
	const hunks = edits.map((e) =>
		buildHunk(e.oldText ?? "", e.newText ?? "", findStartLine(abs, e.oldText ?? "")),
	);
	const removed = hunks.reduce((n, h) => n + h.removed, 0);
	const added = hunks.reduce((n, h) => n + h.added, 0);

	const lines = [toolHeader("Update", path), dangerLine(verdict), connector(summarize(removed, added))];
	if (!exists) lines.push(`  ${paint(S_DIM, "(file does not exist, will be created)")}`);
	for (const hunk of hunks) {
		lines.push("");
		lines.push(...renderDiff(hunk.rows));
	}
	lines.push("");
	lines.push(paint(S_WHITE, "Do you want to proceed?"));
	return lines.join("\n");
}

function buildWritePrompt(path: string, content: string, abs: string, verdict: Verdict): string {
	const all = content.split("\n");
	const exists = existsSync(abs);
	const count = `${all.length} line${all.length === 1 ? "" : "s"}`;
	const summary = exists ? `Overwrote the file with ${count}` : `Created a new file with ${count}`;

	const shown = all.slice(0, MAX_DIFF_LINES);
	const rows: DiffRow[] = shown.map((text, i) => ({ ln: i + 1, sign: "+", text }));
	if (all.length > shown.length) {
		rows.push({ ln: null, sign: " ", text: `… ${all.length - shown.length} more lines` });
	}

	const lines = [toolHeader("Write", path), dangerLine(verdict), connector(summary), ""];
	lines.push(...renderDiff(rows));
	lines.push("");
	lines.push(paint(S_WHITE, "Do you want to proceed?"));
	return lines.join("\n");
}

function buildToolPrompt(name: string, arg: string, verdict: Verdict): string {
	return [toolHeader(name, arg), dangerLine(verdict), "", paint(S_WHITE, "Do you want to proceed?")].join("\n");
}

// ---------- diff helpers ----------

const CONTEXT = 2;
const MAX_DIFF_LINES = 16;

interface DiffRow {
	ln: number | null;
	sign: " " | "-" | "+";
	text: string;
}

interface Hunk {
	rows: DiffRow[];
	removed: number;
	added: number;
}

/** Line-level diff with real line numbers, folded to CONTEXT lines of context. */
function buildHunk(oldText: string, newText: string, startLine: number): Hunk {
	const o = oldText.split("\n");
	const n = newText.split("\n");

	let prefix = 0;
	while (prefix < o.length && prefix < n.length && o[prefix] === n[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < o.length - prefix &&
		suffix < n.length - prefix &&
		o[o.length - 1 - suffix] === n[n.length - 1 - suffix]
	) {
		suffix++;
	}

	const removed = o.length - prefix - suffix;
	const added = n.length - prefix - suffix;
	const rows: DiffRow[] = [];

	const beforeStart = Math.max(0, prefix - CONTEXT);
	if (beforeStart > 0) {
		rows.push({ ln: null, sign: " ", text: `… ${beforeStart} unchanged line${beforeStart === 1 ? "" : "s"}` });
	}
	for (let i = beforeStart; i < prefix; i++) rows.push({ ln: startLine + i, sign: " ", text: o[i] });
	for (let i = prefix; i < o.length - suffix; i++) rows.push({ ln: startLine + i, sign: "-", text: o[i] });
	for (let j = prefix; j < n.length - suffix; j++) rows.push({ ln: startLine + j, sign: "+", text: n[j] });

	const afterNewStart = n.length - suffix;
	const afterCount = Math.min(CONTEXT, suffix);
	for (let k = 0; k < afterCount; k++) {
		rows.push({ ln: startLine + afterNewStart + k, sign: " ", text: n[afterNewStart + k] });
	}
	if (suffix > afterCount) {
		rows.push({ ln: null, sign: " ", text: `… ${suffix - afterCount} unchanged line${suffix - afterCount === 1 ? "" : "s"}` });
	}

	return { rows: clampRows(rows), removed, added };
}

/** Keep the diff readable: head + tail with a middle ellipsis. */
function clampRows(rows: DiffRow[]): DiffRow[] {
	if (rows.length <= MAX_DIFF_LINES) return rows;
	const head = rows.slice(0, MAX_DIFF_LINES - 3);
	const tail = rows.slice(rows.length - 2);
	return [...head, { ln: null, sign: " ", text: "…" }, ...tail];
}

function renderDiff(rows: DiffRow[]): string[] {
	return rows.map((r) => {
		if (r.ln === null) return paint(S_DIM, `      ${r.text}`);
		const num = String(r.ln).padStart(4);
		if (r.sign === "-") return paint(S_DEL, `   ${num} - ${r.text}`);
		if (r.sign === "+") return paint(S_ADD, `   ${num} + ${r.text}`);
		return `${paint(S_DIM, `   ${num}`)}   ${paint(S_TEXT, r.text)}`;
	});
}

/** Find the 1-based line where oldText starts in abs (for real diff numbers). */
function findStartLine(abs: string, oldText: string): number {
	if (!oldText) return 1;
	try {
		if (statSync(abs).size > 2 * 1024 * 1024) return 1; // skip huge files
		const file = readFileSync(abs, "utf8");
		const idx = file.indexOf(oldText);
		if (idx < 0) return 1;
		let line = 1;
		for (let i = 0; i < idx; i++) if (file.charCodeAt(i) === 10) line++;
		return line;
	} catch {
		return 1;
	}
}

// ---------- preview helpers ----------

/** Truncate text: maxLines lines, maxCols chars per line */
function clip(text: string, maxLines: number, maxCols: number): string[] {
	const lines = text.split("\n");
	const out = lines
		.slice(0, maxLines)
		.map((l) => (l.length > maxCols ? `${l.slice(0, maxCols)}…` : l));
	if (lines.length > maxLines) out.push(`…(${lines.length - maxLines} more lines omitted)`);
	return out;
}

/** Short one-line summary of a non-core tool's input, for the generic prompt. */
function briefInput(input: unknown): string {
	if (input && typeof input === "object") {
		const o = input as Record<string, unknown>;
		if (typeof o.path === "string") return o.path;
		if (typeof o.command === "string") return clip(o.command, 1, 80)[0] ?? "";
		try {
			const s = JSON.stringify(input);
			return s.length > 80 ? `${s.slice(0, 80)}…` : s;
		} catch {
			return "";
		}
	}
	return typeof input === "string" ? input : "";
}
