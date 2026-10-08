/**
 * Memory-Document Agent Loop (v1) — implements design.md.
 *
 * Engaged per session via slash command, not at load time:
 *   /memento         engage (idempotent; bootstraps thinking dir + memory.md)
 *   /memento off     disengage — pi's normal behavior resumes immediately
 *   /memento status  show current state
 * While disengaged the extension is fully inert: no prompt injection, no tool
 * gating, no handoffs. Overflow and /compact use pi's default routine.
 *
 * After any tool call that touches a path outside the thinking dir ("boundary
 * crossing"), the session is handed off: compaction with deterministic content,
 * no LLM call. The next request's context = system prompt (protocol + goal)
 * + memory.md read from disk as the summary + last K transitions verbatim
 * (K = assistant messages that carry tool calls, cut on a valid boundary).
 *
 * Gate: every crossing — plain reads included — is blocked until memory.md has
 * been edited on disk since the last handoff. The gate compares hashes, so any
 * edit path counts; it cannot be bypassed by prompt-level discipline alone.
 *
 * Env config:
 *   MEMENTO_DIR   thinking dir, relative to project root  (default "thinking")
 *   MEMENTO_K     transitions kept verbatim per handoff    (default 1)
 *   MEMENTO_GOAL  goal file path                           (default <root>/goal.md, fallback .pi/goal.md)
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ROOT = process.cwd();
const THINKING_DIR = path.resolve(ROOT, process.env.MEMENTO_DIR ?? "thinking");
const K = Math.max(1, Number(process.env.MEMENTO_K ?? 1));
// Goal resolution order: env override, then root goal.md, then .pi/goal.md (legacy).
const GOAL_CANDIDATES = [path.join(ROOT, "goal.md"), path.join(ROOT, ".pi", "goal.md")];
const GOAL_FILE = process.env.MEMENTO_GOAL
	? path.resolve(ROOT, process.env.MEMENTO_GOAL)
	: GOAL_CANDIDATES.find((c) => readText(c)?.trim()) ?? GOAL_CANDIDATES[0];
const MEMORY_FILE = path.join(THINKING_DIR, "memory.md");
const SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");

// Minimal starter content for a fresh memory.md. No prescribed structure: the
// agent organizes and updates it however serves the task best.
const MEMORY_SEED = `# Memory

(empty — distill durable state here before each boundary crossing; structure is yours)
`;

let armed = false; // set by /memento; every hook no-ops while disengaged
// Set when a boundary crossing lands; consumed by the handoff that follows it.
let crossedSinceLastHandoff = false;
// Staleness detector (design.md §7 metric): consecutive handoffs where memory.md
// never changed mean external ops landed without distilled state — the core failure mode.
let lastHandoffMemoryHash: string | null = null;
// Gate baseline: memory.md hash at the most recent handoff (or arming). A
// crossing call is blocked while the on-disk hash still equals this.
let baselineMemoryHash: string | null = null;

function readText(p: string): string | undefined {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return undefined;
	}
}

/** True iff p is a path inside the thinking dir (resolved against project root). */
function insideThinking(p: unknown): boolean {
	if (typeof p !== "string") return false;
	const r = path.resolve(ROOT, p);
	return r === THINKING_DIR || r.startsWith(THINKING_DIR + path.sep);
}

/** Current sha256 of memory.md on disk, or null when the file is missing. */
function memoryHash(): string | null {
	const raw = readText(MEMORY_FILE);
	return raw === undefined ? null : createHash("sha256").update(raw).digest("hex");
}

/** Engage the loop for this session. Returns an error message, or undefined on success. */
function arm(): string | undefined {
	if (armed) return "already engaged — /memento off to disengage";
	const goalRaw = readText(GOAL_FILE)?.trim();
	if (!goalRaw) {
		return `no non-empty goal file at ${GOAL_FILE} — create it first, then retry`;
	}
	// Bootstrap loop state on arm: create the thinking dir and seed memory.md.
	mkdirSync(THINKING_DIR, { recursive: true });
	if (readText(MEMORY_FILE) === undefined) writeFileSync(MEMORY_FILE, MEMORY_SEED);
	baselineMemoryHash = memoryHash(); // first external call of an engagement must distill into the current state
	crossedSinceLastHandoff = false;
	lastHandoffMemoryHash = null; // reset staleness detector for this engagement
	armed = true;
	return undefined;
}

function disarm(): void {
	armed = false;
	crossedSinceLastHandoff = false;
	// Gate/staleness state is inert while disengaged; re-arming refreshes it.
}

function buildSummary(): string {
	const goal = readText(GOAL_FILE)?.trim() ?? "(no goal file at " + GOAL_FILE + ")";
	const memory =
		readText(MEMORY_FILE)?.trim() ??
		"(memory.md missing — state unknown. Inspect the workspace, rebuild this document before acting.)";
	return [
		"Memory-document handoff.",
		"",
		"## GOAL (immutable)",
		goal,
		"",
		"## MEMORY (thinking/memory.md at handoff time)",
		memory,
	].join("\n");
}

interface RawEntry {
	id?: string;
	type?: string;
	message?: { role?: string; content?: unknown };
}

/**
 * Walk back from the leaf counting transitions = assistant messages carrying
 * >= 1 tool call. Returns the id of the K-th one (the oldest kept entry), or
 * null when fewer than K exist (caller falls back to pi's own default cut).
 * Cutting on an assistant message is always a valid boundary: its tool results
 * follow it, so no action/result pair is ever split.
 */
function cutPointForK(entries: RawEntry[]): string | null {
	let found = 0;
	let oldestTransitionId: string | null = null;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (!e || e.type !== "message" || e.message?.role !== "assistant") continue;
		const content = Array.isArray(e.message.content) ? e.message.content : [];
		if (content.some((b: { type?: string }) => b?.type === "toolCall")) {
			found++;
			oldestTransitionId = e.id ?? oldestTransitionId;
			if (found >= K && e.id) return e.id;
		}
	}
	// Fewer than K transitions exist yet: keep everything from the first
	// transition onward instead of null (null would self-retain nothing).
	return oldestTransitionId;
}

const PROTOCOL = `## MEMORY-DOCUMENT LOOP — how your world works

Your context does not accumulate across external actions. After ANY tool call that touches a path outside ${path.relative(ROOT, THINKING_DIR)}/ (file reads/writes/edits there, greps or finds without an explicit thinking scope, every bash command, web tools), the session is handed off mechanically before your next model request: everything older than the last ${K} action/result pairs is removed from context.

What you wake up with after a handoff — exactly:
  this prompt (protocol + goal) + memory.md contents + the last ${K} transitions verbatim.

Anything not written to disk does not exist for future-you after a handoff: in-flight reasoning, intermediate observations, "what I was about to do". This is mechanical and cannot be overridden — it is the enforcement of your memory discipline, not a suggestion.

Consequence (the one rule that matters, mechanically enforced): ANY external call of a step — including a plain read — is BLOCKED while ${path.relative(ROOT, MEMORY_FILE)} has not changed on disk since the last handoff. So at the start of every episode between handoffs, update it first in whatever form serves you best; if nothing durable changed, still make some edit (e.g., refresh your current intent) before acting.

memory.md has no required structure: organize and update it however is most useful to future-you after a handoff — sections, freeform prose, anything — and reorganize freely as the task evolves. The only hard requirement on it (mechanically enforced): it must change on disk before every crossing episode. If content is irreproducible and must survive a handoff, copy it into ${path.relative(ROOT, THINKING_DIR)}/ with write BEFORE the external call that makes you need to cross.

The rest of ${path.relative(ROOT, THINKING_DIR)}/ is yours for working state — notes, partial drafts, intermediate lists. Writes there are free: they never trigger a handoff. But they do not ride into post-handoff context unless you re-read them — use them within the current episode; leave some trace in memory.md (in whatever form fits) if future-you should look back.

Ground truth is on disk: every message, tool call, and result ever sent is retained verbatim in the pi session file (newest .jsonl under a project-named subdir of ${SESSIONS_DIR}). Before re-running an expensive operation whose output may already exist there, grep it instead:
  rg -n "<distinctive string from the old output>" <session-file.jsonl>

A handoff is only triggered by a tool call.  If you want user intervention, just stop.  If you want to proceed, you need to make a tool call.  

You can delegate work to sub-agents as needed.  (They are not subject to the handoff rules here.)  

## Empirical gate behavior (important)
- Each assistant tool batch = one "turn". At every turn_end where ≥1 crossing landed, \`crossedSinceLastHandoff\` is consumed AND **baselineMemoryHash resets to memory.md's current hash** — even mid-exchange. So after any turn containing external calls, the next external call (reads too) is blocked until memory.md changes on disk again. 
- Blocked calls do NOT set the crossing flag → their turns end without compaction → context survives that boundary.
- Writes inside \`thinking/\` are fully exempt: no gate check, no flag, no handoff — they keep you in the same episode. Use them to arm the gate and preserve state.
- Practical rule: before any turn whose first call is external, make a memory.md edit; if an earlier turn of the same exchange already crossed, one more memory.md edit is needed before further external calls.


Do not re-read or re-derive what memory.md plus the verbatim window already give you.`;

export default function (pi: ExtensionAPI) {
	// --- /memento [on | off | status] — engage/disengage on demand.
	pi.registerCommand("memento", {
		description: "Memory-document loop: on (default) | off | status",
		getArgumentCompletions: (prefix) => {
			const opts = ["on", "off", "status"];
			const filtered = opts.filter((o) => o.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((v) => ({ value: v, label: v })) : null;
		},
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			if (sub === "off") {
				if (!armed) return void ctx.ui.notify("[memento] not engaged", "info");
				disarm();
				return void ctx.ui.notify(
					"[memento] disengaged — normal prompt, tools and compaction resume immediately",
					"info",
				);
			}
			if (sub === "status") {
				const state = armed ? `ENGAGED (K=${K})` : "disengaged";
				return void ctx.ui.notify(
					`[memento] ${state}\n  thinking: ${THINKING_DIR}\n  memory:   ${MEMORY_FILE}\n  goal:     ${GOAL_FILE}`,
					"info",
				);
			}
			if (sub !== "" && sub !== "on") {
				return void ctx.ui.notify(`[memento] unknown argument "${sub}" — use on, off or status`, "warning");
			}
			const err = arm();
			if (err) return void ctx.ui.notify(`[memento] ${err}`, "error");
			ctx.ui.notify(
				`[memento] engaged — K=${K}, thinking=${THINKING_DIR}\n  first external call is gated: update ${MEMORY_FILE} before it`,
				"info",
			);
		},
	});

	// --- Protocol + goal injection: append to pi's base prompt every request.
	pi.on("before_agent_start", async (event) => {
		if (!armed) return undefined; // disengaged: normal system prompt, untouched
		const goal =
			readText(GOAL_FILE)?.trim() ??
			"(no goal file found — confirm the objective with the human before acting)";
		return { systemPrompt: event.systemPrompt + "\n\n" + PROTOCOL + "\n## GOAL (immutable)\n" + goal };
	});

	// --- Path guards + boundary-crossing detection.
	pi.on("tool_call", async (event) => {
		if (!armed) return undefined; // disengaged: all tools unrestricted, incl. editing the goal file
		const input = event.input as Record<string, unknown>;

		if (event.toolName === "write" || event.toolName === "edit") {
			const target = typeof input.path === "string" ? path.resolve(ROOT, input.path) : undefined;
			if (target === GOAL_FILE) {
				return {
					block: true,
					reason: `${GOAL_FILE} is immutable — the goal cannot be changed by tools. If the goal needs to change, ask the human to edit it.`,
				};
			}
		}

		// Default to crossing; exempt only what is provably thinking-local.
		if (insideThinking(input.path)) return undefined;

		// Gate: this call's result will be distilled at the next handoff, so
		// memory.md must already carry anything durable from this episode. On-disk
		// hash comparison — edits via any tool count. A blocked
		// call does not set the crossing flag (no handoff follows it).
		const h = memoryHash();
		if (h === baselineMemoryHash) {
			return {
				block: true,
				reason: `${MEMORY_FILE} is unchanged since the last handoff — update it first, then retry this call.`,
			};
		}
		crossedSinceLastHandoff = true;
	});

	// --- Handoff trigger: at turn end, if a crossing landed this turn, chain a
	// deterministic compaction entry for the next model request.
	pi.on("turn_end", async (event) => {
		if (!armed || !crossedSinceLastHandoff) return undefined; // disengaged or no crossing: normal flow continues
		crossedSinceLastHandoff = false; // consumed here; session_before_compact also clears on any handoff
		baselineMemoryHash = memoryHash(); // this compaction is the next episode's gate baseline
		const projected: RawEntry[] = ((event as { context?: { contextEntries?: Array<{ sourceEntry?: RawEntry }> } })
			.context?.contextEntries ?? []).map((p) => p.sourceEntry ?? ({}));
		return {
			entries: [
				{ type: "compaction", summary: buildSummary(), firstKeptEntryId: cutPointForK(projected) },
			],
			continue: true,
		};
	});

	// --- Handoff content (also covers manual /compact and the overflow safety net).
	pi.on("session_before_compact", async (event) => {
		if (!armed) return undefined; // disengaged compactions use pi's default LLM routine
		crossedSinceLastHandoff = false; // a handoff is happening regardless of who triggered it
		const memoryRaw = readText(MEMORY_FILE);
		const h = memoryRaw ? createHash("sha256").update(memoryRaw).digest("hex") : "";
		if (lastHandoffMemoryHash !== null && h === lastHandoffMemoryHash) {
			console.error(
				"[memento] WARNING: handoff with memory.md unchanged since the previous handoff — state may be stale",
			);
		}
		lastHandoffMemoryHash = h;
		baselineMemoryHash = memoryRaw === undefined ? null : h; // keep the gate in sync on pipeline compactions too
		const branch: RawEntry[] = ((event as unknown as { branchEntries?: RawEntry[] }).branchEntries ?? []).map(
			(e) => e,
		);
		return {
			compaction: {
				summary: buildSummary(),
				firstKeptEntryId: cutPointForK(branch) ?? (event.preparation as { firstKeptEntryId?: string })?.firstKeptEntryId ?? null,
				tokensBefore: (event.preparation as { tokensBefore?: number })?.tokensBefore,
			},
		};
	});

	console.error(`[memento] loaded — run /memento to engage (K=${K})`);
}
