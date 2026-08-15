# tdd-guardian

TDD Guardian plugin for Claude Code. Enforces strict test-driven development with automated quality gates across unit, integration, e2e, and contract test lanes.

## Project structure

```
.claude-plugin/
  plugin.json             Plugin metadata
.github/workflows/
  verify.yml              CI — tests on Node 18/20/22/24, nlpm-check, badge freshness
hooks/
  hooks.json              Hook registration (auto-discovered by Claude Code)
agents/                   Specialized subagents for TDD workflow
  tdd-planner.md          Work item planning
  tdd-test-designer.md    Behavior-driven test design
  tdd-implementer.md      Small-batch implementation
  tdd-coverage-auditor.md Coverage gate enforcement
  tdd-mutation-auditor.md Mutation testing (report-only)
  tdd-reviewer.md         Final code + test quality review
commands/                 11 commands; basename = command name (see Command naming)
                          init, probe, gate, status, plan, design-tests,
                          implement, audit-coverage, audit-mutation, review, workflow
  shared/                 Partials — not user-invocable
    load-config.md        Load, migrate v1→v2, validate lanes
    detect-tooling.md     CI-first detection with dry-run probes
    run-lane.md           Lane execution and outcome classification
    parse-coverage.md     9-format parsing and merging
    parse-mutation.md     Mutation report parsing
config/
  config.json             Default configuration template (schema v2)
scripts/
  ci/nl-artifacts-hash.py Content hash backing the nlpm score attestation
  tdd-guardian/
    lib/config.js         Config load, v1→v2 migration, validation
    lib/coverage.js       9-format coverage parser + union/weighted merge
    lib/lanes.js          Lane selection, execution, state, freshness
    lib/exec.js           Command execution and outcome classification
    pretool_guard.js      PreToolUse hook
    taskcompleted_gate.js TaskCompleted hook
skills/tdd-guardian/      9 skills
    policy-core/          Assertion hierarchy, mock rules, completion gates
    lane-policy/          Test-level taxonomy
    tooling-catalog/      Per-language tooling reference (SKILL.md + 9 references)
    test-matrix/          Test matrix design
    coverage-gate/        Coverage enforcement
    mutation-gate/        Mutation testing
    review-gate/          Code + test quality review
    init/, workflow/      Setup and orchestration
tests/                    node --test suite (no dependencies)
```

## Conventions

### Lanes

A lane is one test tier with its own command, trigger, and coverage participation. Config schema v2 replaced the single `testCommand`/`coverageCommand` pair with a `lanes` array.

Triggers: `taskCompleted` (the hook *runs* these), `commit` and `push` (checked for *freshness*), `manual`. **`push` subsumes `commit`.**

Schema v1 configs keep working — `lib/config.js` migrates them in memory to a single `unit` lane, preserving the original two-command behaviour exactly. Never change that migration's semantics without a major version bump.

### Test quality enforcement

Two independent axes, both required for every test:

- **Assertion level** (`policy-core`) — how strongly the test verifies anything. Every test needs at least one Level 1-5 assertion; Level 6-7 only is a wiring test and is rejected.
- **Lane** (`lane-policy`) — at what level the behavior is verified. The deciding question: *would this test still pass if the real collaborator were broken?* If yes, it belongs one lane higher.

### Fail-loud invariants

These are load-bearing. Do not soften them without stating the mechanism that makes it safe:

1. **A zero-test run is a failure**, not a pass — *once the lane has ever had tests*. Green with nothing run is indistinguishable from green with everything run. Before a lane's first test it is in **bootstrap**: reported loudly on every gate run but not blocking, because a greenfield repo is not a broken one. `ever_had_tests` is a one-way ratchet, so deleting every test cannot restore bootstrap. The invariant guards against a *silent* zero-test run; nothing in bootstrap is silent.
2. **A coverage report measuring zero lines fails.** Under the 0/0 convention it scores 100%. Skipped while a lane is in bootstrap — no tests means nothing to measure.
3. **A `null` metric is not zero** — it means the format does not measure that dimension. Non-zero threshold + null = WARNING, never FAILURE.
4. **A weighted coverage merge is reported as approximate.** Only per-line formats merge as a true union.
5. **Freshness checks the working tree, not just commits.** Uncommitted edits invalidate a gate.
6. **An environment failure never triggers a code fix.** A missing runner is not a failing test — in the plugin's gates, and in its own test suite, where the git-dependent tests skip with a stated reason rather than reporting as logic failures.
7. **A failing lane must not advance `last_passed_at` or `last_head_sha`.** A bootstrap lane does record them, so a greenfield repo is not deadlocked on a gate that cannot pass until a test exists.
8. **Never write a zero-lane config.** It is invalid, so both hooks fail closed — and the error would tell the user to run the command that produced it. When there is no tooling to detect, `/tdd-guardian:init` writes nothing; a silent plugin beats a deadlocked one.

### Hook scripts

- Registered via `hooks/hooks.json` using `${CLAUDE_PLUGIN_ROOT}` paths.
- `pretool_guard.js` classifies Bash commands as commit-class or push-class by **tokenizing segments**, not by regex-matching the raw string — so `echo "git push"` does not false-positive and `git -C /repo commit` does not slip through.
- `taskcompleted_gate.js` runs the `taskCompleted` lanes, merges coverage, and runs the mutation gate when bound.
- Both read `.claude/tdd-guardian/config.json` and write `.claude/tdd-guardian/state.json`.
- Shared logic lives in `scripts/tdd-guardian/lib/`. **Put new gate logic there, not in a hook** — both hooks and four commands depend on it, and only the lib is tested.

### Command naming

Claude Code registers a plugin command as `/<plugin-name>:<file-basename>`. Never prefix a command file with `tdd-guardian-` — the plugin namespace is already applied. Keep the basename bare (`plan.md` → `/tdd-guardian:plan`) and the `name:` frontmatter identical to the basename.

### Adding a language to the catalog

1. Add the manifest fingerprint to `skills/tdd-guardian/tooling-catalog/SKILL.md`.
2. Add the language to the matching `references/*.md`: runner detection, test command, coverage command, output format and path, mutation tool, probe command, gotchas.
3. If its coverage format is not one of the nine already parsed, add a parser to `lib/coverage.js` **and** a test to `tests/coverage.test.js`. Do not document a format the parser cannot read.
4. Same rule for mutation tools: `commands/shared/parse-mutation.md` must be able to read the report, or the catalog must not propose the tool.

### Adding new skills

1. Create `skills/tdd-guardian/<name>/SKILL.md` with YAML frontmatter.
2. Reference `policy-core` for governance rules and `lane-policy` for test levels.
3. Add a `## Scope` section — nlpm R07 requires it, and it stops skills from overlapping.
4. Update `README.md` and `GUIDE.md`.

### Adding new agents

1. Create `agents/tdd-<name>.md` with YAML frontmatter including `model:` and a least-privilege `tools:`.
   - **The field is `tools:`, never `allowed-tools:`.** `allowed-tools:` is the *command* field; a subagent declaring it gets no restriction at all and silently inherits the full tool pool. Every agent here shipped with that bug until 0.9.0, so the `## Tools` table claimed a least-privilege boundary that was never in effect — including on the read-only reviewer, whose entire safety argument is that it cannot edit what it reviews. A restriction that does not restrict is worse than none, because it stops anyone looking.
2. Add a `## Tools` table to the body naming what each declared tool is for. An audit/review/scan agent must not declare `Write` or `Edit`.
3. Add a `## Output format` section with a concrete template.
4. Reference in `commands/workflow.md` if part of the workflow, and update `README.md`.
5. Verify the frontmatter actually restricts: `awk '/^---$/{n++;next} n==1 && /^tools:/' agents/*.md` must print one line per agent.

## Prerequisites

- Node.js 18+ (hooks and tests run via `node`; no package manager, no `npm install`). Verified in CI on 18, 20, 22, and 24.
- Claude Code 1.0 or later (for `${CLAUDE_PLUGIN_ROOT}` expansion and `TaskCompleted` hook support)
- `git` on PATH for the freshness tests; without it they skip with a stated reason
- Python 3 for `nlpm-check` and the artifact hash (stdlib only)

## Development

### Running the test suite

```bash
node --test                         # discovers tests/, works on Node 18+
node --test tests/coverage.test.js  # one file
```

162 tests cover every coverage format, config migration and validation, lane selection and freshness, exit-code classification, and both hooks end to end.

**Do not "simplify" the bare form to `node --test "tests/**/*.test.js"`.** Node's `--test` glob support arrived in Node 21; on 18 and 20 that invocation matches nothing, runs no tests, and **exits 0** — a silent green no-op of exactly the kind this plugin exists to catch.

**Any change to `scripts/tdd-guardian/lib/` or the hooks requires a test.** `tests/hooks.test.js` drives the hooks exactly as Claude Code does — a JSON payload on stdin, a JSON decision on stdout.

### Testing hooks by hand

```bash
# PreToolUse — simulate a blocked `git commit`
echo '{"tool_name":"Bash","tool_input":{"command":"git commit -m wip"},"cwd":"'"$PWD"'"}' \
  | node scripts/tdd-guardian/pretool_guard.js

# PreToolUse — push-class, which additionally requires the push lanes
echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main"},"cwd":"'"$PWD"'"}' \
  | node scripts/tdd-guardian/pretool_guard.js

# TaskCompleted — run the taskCompleted lanes
echo '{"cwd":"'"$PWD"'"}' | node scripts/tdd-guardian/taskcompleted_gate.js
```

Empty stdout means "no opinion" (allow). PreToolUse emits `permissionDecision: "allow"|"deny"`; TaskCompleted emits `decision: "block"` with the failure context.

### CI

`.github/workflows/verify.yml` runs on push and PR:

| Job | Checks |
|-----|--------|
| `test` | Full suite on Node 18/20/22/24. Fails on any failure, on **zero tests discovered**, on any skip (CI has git), and if the README test-count badge drifted |
| `artifacts` | Every JSON file parses; `nlpm-check --strict`; the committed `nlpm-badge.json` matches a fresh regeneration; warns if the score attestation is stale |
| `hooks` | Both hooks stay silent on an uninitialised project and survive malformed and empty stdin |

If `xiaolai/nlpm` cannot be fetched, the nlpm steps emit a **warning saying they were skipped** rather than passing quietly.

### Refreshing the README badges

| Badge | Source | Refresh |
|-------|--------|---------|
| Validated by NLPM | `nlpm-badge.json` | `nlpm-check --json . \| nlpm-badge > nlpm-badge.json` — CI fails if stale |
| nlpm score | `nlpm-score.json` | Run `/nlpm:score`, update the file and the README number — CI warns if stale |
| tests N passing | static | `node --test`, update the count — CI fails if it drifts |

The score badge is the one CI cannot recompute, because scoring needs the nlpm scorer agent. It verifies the next best thing — a content hash of every NL artifact:

```bash
python3 scripts/ci/nl-artifacts-hash.py --check
```

`nlpm-check` and `nlpm-badge` ship in the nlpm plugin's `bin/`.

### JSON validation

```bash
jq . .claude-plugin/plugin.json hooks/hooks.json config/config.json .claude-plugin/marketplace.json
```
