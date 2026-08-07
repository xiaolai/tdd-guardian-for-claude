# Functional — Elixir, Erlang, Haskell, OCaml

## Elixir

Detection: `mix.exs`, `test/`, `test/test_helper.exs`.

| | |
|---|---|
| Test command | `mix test` |
| With coverage | `mix coveralls.json` (excoveralls) or `mix test --cover` (built-in) |
| Summary path | `cover/excoveralls.json` — **not a format the gate parses** |
| Preferred | `mix coveralls.lcov` → `cover/lcov.info` (format: `lcov`) |
| Probe | `mix test --only nonexistent_probe_tag` |

The built-in `--cover` writes HTML only. Use excoveralls and **choose the LCOV reporter**, since the excoveralls JSON schema is its own and unsupported:

```elixir
# mix.exs
def project do
  [test_coverage: [tool: ExCoveralls], preferred_cli_env: [coveralls: :test]]
end
```

Excoveralls measures lines only — set `functions` and `branches` thresholds to 0.

**Lane splitting** is by ExUnit tag, and Phoenix projects come with the split already made:

```elixir
# test/test_helper.exs
ExUnit.configure(exclude: [:integration, :e2e])
```

| Lane | Command | Trigger |
|------|---------|---------|
| unit | `mix test` | `["taskCompleted", "commit"]` |
| integration | `mix test --only integration` | `["commit"]` |
| e2e | `mix test --only e2e` | `["push"]` |

Ecto projects need a database for anything touching a repo, even "unit" tests. `MIX_ENV=test mix ecto.create && mix ecto.migrate` belongs in `setupCommand`, not in the lane command.

Mutation: `muzak` (the free tier is limited; `muzak_pro` is commercial). Mutation testing is not well served in Elixir — leave `requireMutation: false`.

## Erlang

Detection: `rebar.config`, `erlang.mk`, `src/*.app.src`.

| | |
|---|---|
| EUnit | `rebar3 eunit` |
| Common Test | `rebar3 ct` |
| With coverage | `rebar3 do eunit --cover, cover` |
| Summary path | `_build/test/cover/*.coverdata` — **binary, unsupported** |
| Probe | `rebar3 ct --suite=nonexistent 2>&1 \| head -3` |

Erlang's `cover` writes its own binary format plus HTML. Neither is machine-readable to the gate. Options:

1. Use `covertool` (`rebar3_covertool` plugin) to emit Cobertura: `rebar3 covertool generate` → `_build/test/covertool/*.covertool.xml`.
2. If covertool is not available, set `coverage: "none"` and all thresholds to 0. A configured path the gate cannot read is worse than an honest "not measured".

EUnit is unit-level, Common Test is integration-level — that is the lane split.

## Haskell

Detection: `*.cabal`, `stack.yaml`, `package.yaml`.

| Build tool | Test command | Coverage |
|------------|--------------|----------|
| Stack | `stack test` | `stack test --coverage` |
| Cabal | `cabal test` | `cabal test --enable-coverage` |

| | |
|---|---|
| Coverage output | HPC `.tix` + HTML under `.stack-work/install/*/hpc/` |
| Machine-readable | `hpc report --xml-output` is not standard; use `hpc-lcov` |
| Preferred | `hpc-lcov --file <path>.tix -o coverage/lcov.info` (format: `lcov`) |
| Probe | `stack test --dry-run` |

Frameworks: hspec (`*Spec.hs`), tasty, HUnit, QuickCheck/Hedgehog for property tests. All report through the cabal/stack test-suite stanza.

A `.cabal` file with more than one `test-suite` stanza is that many lanes: `stack test :unit`, `stack test :integration`.

HPC measures expressions and top-level declarations, which map awkwardly onto lines/functions/branches. Treat the numbers as directional and prefer `coverageMode: "no-decrease"` over absolute thresholds.

Mutation: MuCheck exists but is effectively unmaintained. Leave `requireMutation: false`.

## OCaml

Detection: `dune-project`, `dune`, `*.opam`.

| | |
|---|---|
| Test command | `dune test` |
| With coverage | `dune runtest --instrument-with bisect_ppx --force` |
| Report step | `bisect-ppx-report lcov -o coverage/lcov.info` |
| Summary path | `coverage/lcov.info` (format: `lcov`) |
| Probe | `dune test --display=short --dry-run` |

Requires `bisect_ppx` as a dev dependency. `bisect-ppx-report` also emits `cobertura` and `coveralls`; LCOV is the safest choice.

`--force` matters: dune caches test results and a cached "success" runs nothing. Include it in any gate lane.

Frameworks: alcotest, OUnit2, QCheck (property-based).

## Gotchas

- **Build caches make no-op runs look green.** `dune test`, `stack test`, and `mix test` all skip unchanged targets. Use `--force` (dune) or accept that a lane may not have executed; the gate's `no-tests` detection catches the worst case but not a partial skip.
- **Erlang's native coverdata is binary.** Without covertool, there is nothing for the gate to read — say `coverage: "none"` rather than pointing at a path.
- **Excoveralls' JSON is its own schema**, not any standard. Use the LCOV reporter.
- **HPC's expression-level metrics do not map cleanly to line coverage.** `no-decrease` mode is more meaningful than an absolute threshold here.
- **Elixir tests that touch Ecto need a database even at "unit" level.** Put the setup in `setupCommand` so a missing database reads as a setup failure rather than as failing tests.
- **These ecosystems have weak mutation-testing support.** That is a fact about the ecosystem, not a gap to paper over — leave the mutation gate off and rely on the assertion-hierarchy rules in `policy-core`.
