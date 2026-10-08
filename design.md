# Memory-Document Agent Loop — Design

An agent that context-engineers itself: instead of carrying a growing
conversation transcript, it maintains a **memory document** (`thinking/memory.md`)
on disk as its memory. Whenever its attention crosses into the external world (a
read or write outside `thinking/`, any bash command, any no-path tool such as web
search), the session is handed off: the next request's entire context is protocol +
goal + memory doc + last K transitions — nothing else. A gate makes the loop
self-enforcing: while `memory.md` has not changed on disk since the last handoff,
every crossing call — reads included — is blocked.

## 1. Core loop

```
loop:
  while memory.md unchanged since last handoff: block external calls   # gate (mechanical)
  action = model(protocol + goal + memory.md + last K transitions)     # fresh after each handoff
  result = execute(action)                                             # state lives on disk, not in the session
  if action crossed a boundary: handoff → compact to protocol+goal+memory.md+window K
```

- **GOAL** — the stated objective. Immutable via the tool path: write/edit calls
  targeting it are blocked by the extension; humans change it by editing the file.
  Resolved once at arm: `MEMENTO_GOAL` env override, else `<root>/goal.md`,
  else legacy `.pi/goal.md`; re-read fresh on every request and at each handoff.
- **memory.md** — the agent's belief state, living in `thinking/`. No prescribed
  structure — sections or freeform prose, reorganized as the task evolves. It
  typically holds: plan with statuses, durable facts (paths, decisions,
  constraints), pointer lines for deliberately preserved content, open questions,
  next steps. It holds **completed conclusions and durable state only — never live
  scratch.** Transient reasoning stays in context for its whole lifetime and touches
  memory.md only when distilled at a boundary. Because ephemeral thoughts never enter
  the doc, there is nothing to "trim" later; it stays small by construction (what
  goes in), not by maintenance passes.
- **Last K transitions** — kept verbatim after each handoff. A transition is an
  assistant message carrying ≥1 tool call; K counts those and cuts on one, so no
  action/result pair is ever split across the boundary (K = `MEMENTO_K`,
  default 1). With fewer than K transitions in existence, everything from the oldest
  existing transition onward is kept instead of pi's own cut (which applies only
  when zero exist yet). The most recent detail is always exact and fresh, so memory
  discipline only has to survive *beyond* the window; short-term slips are forgiven.

All state is on disk, so any process can resume from files. Nothing in the loop
requires a long-running service.

## 2. Memory model (hot / cold)

| Tier | Medium | Contents | Access |
|---|---|---|---|
| Hot | memory.md (re-injected at every handoff) | conclusions, plan statuses, pointers to preserved blobs | read from disk into the summary, free |
| Cold | pi session file (JSONL) | complete verbatim ground truth — every message, call, and result that ever entered context, retained on disk after compaction | agent greps its own transcript on demand — the default "page fault" |
| Cold | deliberate copies in `thinking/` | irreproducible blobs the agent chose to keep (pre-mutation diffs, one-shot traces) | pointer line in memory.md |

Key distinctions:

- **Ground truth is free; preservation is judgment.** Compaction changes what gets
  *sent* to the model, not what pi stores — the session file retains every entry
  verbatim on disk. Future-self can grep it directly, so traceability needs no
  pre-selective saving at all. Deliberate copies into `thinking/` are a habit of
  judgment for irreproducible content the agent *knows* it will want back (a
  pre-mutation diff, an expensive one-shot trace); each gets a pointer line in
  memory.md. No dedicated tool: plain `write` suffices — re-emitting is only
  painful for very large blobs; revisit if evals show that happening.
- **Durable vs. ephemeral content decides how hard to capture it:**
  - *Durable artifacts* (files in the repo): a pointer + key facts is nearly
    lossless; re-read on demand. Low risk.
  - *Ephemeral observations* (tool output, error strings, search results): they
    live nowhere else — the genuinely lossy zone. Exact detail must survive
    verbatim in a stash or it's gone at the boundary.
- **Pointers over prose**: anything deliberately preserved gets one line in
  memory.md (`pre-diff of auth module → thinking/pre-auth.diff, taken before the
  refactor`). Without it, copies become a graveyard nobody revisits and look-backs
  fail *silently* (no error signal, just later re-derivation or hallucination).

## 3. Ownership boundaries

- **Agent owns the working tree** (task files) **and `thinking/`**, via ordinary
  read/write/edit/bash/grep.
- **Human owns the version-control timeline.** No *dedicated* git tools exist, but
  nothing strips `bash` either — in v1 this is a convention enforced by model
  discipline, not by the harness. Git would be a second, overlapping state axis on top of file-based memory and muddies "try something" into two competing mental models; if tasks later need repo visibility, grant read-only commands (`status`, `diff`, `log`) only — never mutating ones — via protocol guidance or a filtered bash wrapper (both v2).
- **Memory placement**: `thinking/` sits at the project root and is gitignored in
  this repo (alongside the goal file), so a memory doc rewritten every step keeps
  the user's tree clean and cannot fork with experimental branches. The dir is
  configurable via `MEMENTO_DIR`.

## 4. The handoff trigger: boundary crossing

**Any tool call that touches a path outside `thinking/` triggers a handoff**:
compaction to protocol + goal + current memory.md (read from disk) + last K
transitions verbatim. Only path-based calls whose path resolves into `thinking/`
are exempt — so every bash command and every no-path tool (web search, etc.)
crosses by default; thoughts spanning pure-thinking steps skip serialization.

Why reads count, not just writes: this is less a context-size policy than a
*behavioral enforcement device*. The observed failure in most loops is that the
agent barrels ahead without writing down where it is. A boundary-crossing handoff
makes the cost of not-writing **immediate and certain** — an unstated thought dies
at the very next external read — instead of diffuse. Agents optimize around hard
consequences far better than system-prompt exhortations, so the protocol section
explains *mechanics* ("this is how your world works; what isn't written doesn't
exist for future-you"), not commandments.

Why this placement:

- **Episodes survive the window.** An investigation spanning ≤K external reads
  keeps its full call/result sequence — interleaved reasoning included — verbatim.
  When an episode outgrows K, being forced to checkpoint mid-investigation is
  correct behavior (a competent engineer writes down where they are when a task
  stops fitting in one headful), not a bug of the trigger.
- **No world mutation from undistilled belief.** At every boundary, memory.md
  redefines what the agent thinks it's doing; drift gets bounded at natural
  decision points rather than arbitrary clock ticks.
- **Uniform and mechanically checkable**: a path arg resolving outside `thinking/` — or the absence of any path arg — is the whole test; no read/write effect classification needed.

Trigger taxonomy:

1. **On boundary crossing** (mechanical floor): any external op → deterministic
   compaction at turn end (protocol+goal+memory.md, keep last K). Context can never
   cross an external action without a reset.
2. **Manual / overflow handoffs**: the same deterministic summary content is also
   served for manual `/compact` and pi's built-in overflow compaction — one canonical
   "what you wake up with", no LLM-written summaries anywhere in this loop.
3. **Optional internal refresh**: a thin `step` tool that compacts after purely
   internal sequences (long reasoning/reorganization with no boundary crossing).
   Niche under this model; v2 candidate.

There is deliberately *no* per-event pruning step: big blobs simply wait out the
next handoff, and window K tolerates them meanwhile. If an irreproducible blob must
survive on purpose, the agent copies it with plain `write` before moving on — a
judgment made in-context, not a pipeline stage.

**The gate (shipped, universal).** A `tool_call` handler blocks *any* crossing
call — plain reads included — while memory.md's on-disk hash equals the baseline
captured at the last handoff (or at arm). Any edit path counts (the comparison is
a sha256 of file bytes), so prompt-level discipline alone cannot bypass it; a
blocked call produces no handoff and does not set the crossing flag. The baseline
refreshes after every handoff, including manual/overflow compactions, so the gate
stays in sync on all paths. Rationale: post-handoff compaction is only a soft
teacher for reads that already happened — blocking makes the cost of not-writing
*immediate* instead of retrospective, and mutations from undistilled belief are
exactly what the loop exists to prevent. (The original plan shipped v1 without the
gate; it arrived in practice.) The measurement kept: consecutive handoffs with
memory.md unchanged now emit a console WARNING — warn-only (§7).

**Bash caveat (footnote, no mitigation built):** bash is exempt from nothing — every bash call crosses the boundary and passes through the gate even though its mutations are invisible to a path-based classifier; treating shell commands as free would open exactly that smuggling hole. An agent that smuggles writes still harms its own successor (wakes to stale memory.md + window K, re-derives or guesses) — the design makes memory discipline *self-interested*, and self-defeating trades don't survive. Genuinely trivial ops (`mkdir tmp`, scratch files) skipping documentation is correct judgment; sloppy habitual use shows up in eval metrics (redundant calls, re-derivation) and gets fixed by model or protocol tuning, not brittle command parsing. Built-in threshold compaction remains as a pure context-overflow safety net — intercepted by the extension to serve the same deterministic summary content.

## 5. Implementation: pi extension

Lives at `.pi/extensions/memento/index.ts` (project dir), loaded via discovery or `pi --extension ./...`; iterate with `/reload`. No compilation step (jiti runs TS directly). ~250 lines total; everything else is pi doing its normal job.

**Activation gate.** The extension arms only where a non-empty goal file exists at load time — otherwise it prints `[memento] inactive` and registers nothing, which keeps global installs (`~/.pi/agent/extensions/`) safe in unrelated projects. **Bootstrap on arm:** the thinking dir is created if missing and memory.md seeded with minimal starter content (no prescribed structure); existing files are never overwritten. The first crossing of a fresh session must therefore distill into the seed to pass the gate.

Config via env (read at load): `MEMENTO_DIR` (thinking dir, default `thinking`, relative to project root), `MEMENTO_K` (transitions kept verbatim per handoff, default 1, min 1), `MEMENTO_GOAL` (goal file path; default `<root>/goal.md`, legacy fallback `.pi/goal.md`).

Mapping of design → pi primitives:

| Design element | Pi mechanism |
|---|---|
| Handoff (context reset) | **Compaction with deterministic content**: the summary is built from goal + memory.md read from disk — *no LLM call*. The normal handoff is chained at `turn_end` as a compaction entry (`continue: true`) when a crossing landed that turn; the same builder also serves manual `/compact` and overflow via `session_before_compact`. `firstKeptEntryId` keeps the last K transitions verbatim. |
| Boundary-crossing trigger + gate | A single `tool_call` handler both classifies (path resolves into the thinking dir → exempt, else crossing) and enforces: while memory.md's hash equals the post-handoff baseline it blocks the call with "update memory.md first"; a passing crossing sets the flag that `turn_end` consumes. Uniform for reads, writes, bash, and no-path tools; blocked calls never trigger handoffs. |
| Ground-truth recall | The pi session file already retains every entry verbatim after compaction — future-self greps its own transcript with built-in read/grep (the protocol section gives it the path); no fetch or stash machinery in v1. |
| Protocol + goal injection | A `before_agent_start` handler appends the protocol section + `## GOAL (immutable)` to pi's base prompt on every request. The per-request prompt carries goal + mechanics only — memory.md arrives via the handoff summary, not re-injected each turn. |
| Everyday toolbox | **Keep built-ins active** — read, write, edit, bash, grep. Not new code. |
| Path guards | `tool_call` handler blocks write/edit on the goal file ("the goal cannot be changed by tools"). No restriction on *how* memory.md is edited — whole-file overwrites allowed; the gate enforces that it changes, not how. |
| Audit trail without git | Pi's session JSONL accumulates every step locally even though requests stay bounded (the protocol tells future-self where to grep it). Per-step snapshots are *not* implemented in v1; instead a warn-only staleness signal fires when two consecutive handoffs leave memory.md unchanged. |

**Why not a FastAPI proxy:** all state is already on disk (no service worth
keeping alive); replacing pi would mean reimplementing ~90% of harness complexity
in Python; wrapping headless pi per step breaks single-step granularity because
each process runs its own internal multi-step loop. If remote access or a web
dashboard over memory history is wanted later, prefer pi's built-in RPC/JSON modes
or a thin read-only API — orthogonal to the core loop.

## 6. Known limits (accepted)

- **Result blow-up at the boundary**: huge tool results enter context before they
  can be stashed. Harness truncates with an explicit note ("output truncated; full
  output was N chars"); durable outputs are on disk and pointerizable, ephemeral
  ones accept summarize-or-truncate in-step.
- **Working-set ceiling**: handoffs defer context pressure, they don't remove it —
  a look-back re-inflates that step. If the hot set genuinely exceeds the window
  (e.g., comparing two large diffs verbatim), memory management cannot help; the
  task needs chunked / map-reduce decomposition instead.
- **Episodes longer than K** get checkpointed mid-stream by force. Accepted: this
  is intended discipline, and K is a dial — raise it if testing shows
  re-derivation of intent ("why am I doing this again?").

## 7. Evaluation plan

First experiment: run a ~50-step task, memento vs. plain history, same model.
Track:

- **Redundant tool calls** → compression too aggressive (things forgotten).
- **Re-derivation of known facts** → doc too thin / index discipline weak.
- **Diffs on the goal section** → drift or injection persistence.
- **Self-harm indicators**: redundant work immediately after undocumented bash
  mutations — would show if the incentive framing fails for a given model; fix via
  protocol wording or model choice, not enforcement.
- **Recall failures**: re-running an expensive operation whose output was already in
  the transcript — signal that ground-truth grepping isn't happening (protocol or model).
- **Stale handoffs** (instrumented): consecutive handoffs with memory.md unchanged now emit a console warning — count them against where redundant calls occur: does written state predict later mistakes?

Memory-doc quality tracks model capability (the "summary" is the agent's own memory.md — the handoff itself is deterministic): a weak model writes vague notes and the loop degrades accordingly; expect this design to pay off on long, stateful horizons and to be pure overhead on short tasks.

## 8. Open / v2 items

- Reference-based `stash` tool (copy from last result without re-emission + pointer rewrite) — only if evals show large blobs being re-emitted or recall failures piling up.
- Structured `memory-edit` tool (section ops, no overwrite), if drift observed in testing.
- Optional `step` tool for internal-only refreshes (measure first); per-step memory.md snapshot history as a diff-review aid (the stale gate itself shipped in universal form — see §4).
- Read-only git commands, only if tasks demonstrably need repo visibility.
