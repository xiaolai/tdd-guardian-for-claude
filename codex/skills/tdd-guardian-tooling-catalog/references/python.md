# Python

## Package manager

`uv.lock` → uv, `poetry.lock` → poetry, `Pipfile.lock` → pipenv, `pdm.lock` → pdm, `conda-lock.yml`/`environment.yml` → conda, otherwise plain pip in a venv.

Below, `<run>` is the manager's run prefix: `uv run`, `poetry run`, `pdm run`, `pipenv run`, or empty for a plain venv. **Always use it** — a bare `pytest` picks up whatever is on `PATH`, which is often not the project's environment.

## Runner detection

| Signal | Runner |
|--------|--------|
| `[tool.pytest.ini_options]` in `pyproject.toml`, `pytest.ini`, `conftest.py`, `pytest` dep | pytest |
| `tox.ini` with `[testenv]` | tox (an orchestrator; read what it calls) |
| `nox` dep, `noxfile.py` | nox (same) |
| `tests/test_*.py` with `unittest.TestCase` and no pytest | unittest |
| `hypothesis` dep | property-based tests, still under pytest |

pytest runs unittest-style tests too, so a repo with both is one pytest lane.

## pytest

| | |
|---|---|
| Test command | `<run> pytest` |
| With coverage | `<run> pytest --cov --cov-report=json:coverage.json --cov-report=term` |
| Summary path | `coverage.json` (format: `coverage-py`) |
| Alternative | `--cov-report=xml:coverage.xml` (format: `cobertura`) |
| Probe | `<run> pytest --collect-only -q` |

Requires `pytest-cov`. Without it, `--cov` fails with `unrecognized arguments` — which the gate reports as a runner error, not a test failure.

`--cov` with no value covers everything importable and is usually too broad. Scope it: `--cov=src/mypackage`.

**Branch coverage is off by default.** coverage.py reports `branches: null` unless you enable it, and the gate then warns rather than failing. Turn it on:

```toml
[tool.coverage.run]
branch = true
source = ["src"]
```

coverage.py never measures functions. Set `coverageThresholds.functions` to 0.

## Marker-based lanes

The idiomatic Python lane split is pytest markers. If `pyproject.toml` declares them:

```toml
[tool.pytest.ini_options]
markers = ["integration: needs a database", "e2e: drives a browser"]
addopts = "-m 'not integration and not e2e'"
```

then the repo already has three lanes:

| Lane | Command | Trigger |
|------|---------|---------|
| unit | `<run> pytest -m "not integration and not e2e"` | `["taskCompleted", "commit"]` |
| integration | `<run> pytest -m integration` | `["commit"]` |
| e2e | `<run> pytest -m e2e` | `["push"]` |

Directory splits (`tests/unit/`, `tests/integration/`) work the same way — use the path instead of `-m`.

## unittest

| | |
|---|---|
| Test command | `<run> python -m unittest discover -s tests` |
| With coverage | `<run> coverage run -m unittest discover -s tests` |
| Report step | `<run> coverage json -o coverage.json` |
| Summary path | `coverage.json` |
| Probe | `<run> python -m unittest discover -s tests -v --locals 2>&1 \| head -5` |

Two steps, so put the report step in `coverageReportCommand`.

## tox / nox

These orchestrate environments; they are not runners. Read `tox.ini` / `noxfile.py` to find the underlying command and configure **that** as the lane. A `tox` lane re-creates virtualenvs on every gate run, which is far too slow for `taskCompleted`.

If you must gate on tox itself, use `tox -e py311` (one env, not the full matrix) and put it on `["push"]`.

## Mutation testing

| Tool | Command | Notes |
|------|---------|-------|
| mutmut | `mutmut run` | `pip install mutmut`; results via `mutmut results` |
| cosmic-ray | `cosmic-ray exec <config> <session>` | More configurable, more setup |

Both are slow. Use `["push"]` or `["manual"]`.

## Type checking as preflight

If `mypy`, `pyright`, or `ty` is configured, set it as `preflightCommand`:

```
"preflightCommand": "<run> mypy src"
```

## Gotchas

- **`pytest` exits 5 when it collects nothing.** That is not a pass. The gate classifies zero-test runs as `no-tests` and fails the lane.
- **`--cov` without `pytest-cov` installed** fails as an argument error. Probe before writing the lane.
- **A `conftest.py` that needs a live database** turns what looks like a unit lane into an integration lane. Check the fixtures before assigning the trigger.
- **`coverage.json` is overwritten by every run.** If two lanes both emit coverage, give each its own path (`coverage-unit.json`, `coverage-int.json`).
- **`-p no:randomly` may be needed** for a repeatable order if `pytest-randomly` is installed; a randomly-ordered suite that only sometimes passes is a broken suite, not a flaky gate.
