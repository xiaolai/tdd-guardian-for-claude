# Dynamic — Ruby, PHP, Perl, Lua

## Ruby

Detection: `Gemfile`, `*.gemspec`, `Rakefile`, `.rspec`, `spec/`, `test/`.

| Signal | Runner |
|--------|--------|
| `rspec` gem, `.rspec`, `spec/spec_helper.rb` | RSpec |
| `minitest` gem, `test/test_helper.rb` | Minitest |
| Rails app (`config/application.rb`) | Minitest by default, often RSpec |

| | RSpec | Minitest |
|---|-------|----------|
| Test command | `bundle exec rspec` | `bundle exec rake test` |
| Summary path | see below | see below |
| Probe | `bundle exec rspec --dry-run` | `bundle exec rake test TESTOPTS="--verbose"` |

Always prefix with `bundle exec`. A bare `rspec` resolves against system gems and will use the wrong versions.

**Coverage** is SimpleCov, configured in `spec_helper.rb` rather than on the CLI:

```ruby
require "simplecov"
SimpleCov.start "rails" do
  enable_coverage :branch
  formatter SimpleCov::Formatter::MultiFormatter.new([
    SimpleCov::Formatter::SimpleFormatter,
    SimpleCov::Formatter::CoberturaFormatter,   # simplecov-cobertura gem
  ])
end
```

| Output | Path | Format |
|--------|------|--------|
| Default resultset | `coverage/.resultset.json` | `simplecov` |
| Cobertura formatter | `coverage/coverage.xml` | `cobertura` |
| LCOV formatter | `coverage/lcov/<project>.lcov` | `lcov` |

The default `.resultset.json` works, but **prefer the Cobertura or LCOV formatter** — SimpleCov's native format reports no functions and, without `enable_coverage :branch`, no branches either.

Rails splits lanes naturally: `spec/models` + `spec/services` are unit, `spec/requests` + `spec/system` are integration/e2e. System specs drive a browser via Capybara — that is a `["push"]` lane.

Mutation: `mutant` with `mutant-rspec` or `mutant-minitest` (`bundle exec mutant run`). Excellent but requires a licence for commercial use.

## PHP

Detection: `composer.json`, `phpunit.xml`, `phpunit.xml.dist`, `tests/`, `Pest.php`.

| Signal | Runner |
|--------|--------|
| `phpunit/phpunit` require-dev | PHPUnit |
| `pestphp/pest` require-dev | Pest (built on PHPUnit) |
| `codeception/codeception` | Codeception |
| `behat/behat` | Behat (BDD, usually an e2e lane) |

| | |
|---|---|
| Test command | `vendor/bin/phpunit` (or `vendor/bin/pest`) |
| With coverage | `vendor/bin/phpunit --coverage-clover coverage/clover.xml` |
| Summary path | `coverage/clover.xml` (format: `clover`) |
| Alternative | `--coverage-cobertura coverage/cobertura.xml` |
| Probe | `vendor/bin/phpunit --list-tests` |

**Coverage needs a driver.** Without Xdebug or pcov loaded, PHPUnit prints a warning and produces no report — the lane then fails on a missing report, which is the correct outcome but a confusing one until you know why. Check with `php -m | grep -iE 'xdebug|pcov'`. pcov is far faster for coverage; Xdebug is needed for step debugging.

With Xdebug 3, coverage also requires `XDEBUG_MODE=coverage` in the environment:

```
"command": "XDEBUG_MODE=coverage vendor/bin/phpunit --coverage-clover coverage/clover.xml"
```

PHPUnit's `<testsuites>` in `phpunit.xml` is the lane split:

```
vendor/bin/phpunit --testsuite Unit
vendor/bin/phpunit --testsuite Feature
```

Mutation: Infection (`vendor/bin/infection`), which reads the Clover report you already produce. Report at `infection.log` / `infection-log.json`.

## Perl

Detection: `cpanfile`, `Makefile.PL`, `Build.PL`, `t/` directory, `*.t` files.

| | |
|---|---|
| Test command | `prove -lr t/` |
| With coverage | `cover -test` (Devel::Cover) |
| Report step | `cover -report cobertura` → `cover_db/cobertura.xml` |
| Summary path | `cover_db/cobertura.xml` (format: `cobertura`) |
| Probe | `prove -lr --dry t/` |

Devel::Cover is slow — 10–20x the uninstrumented run is normal. Keep the coverage lane off `taskCompleted`.

## Lua

Detection: `*.rockspec`, `.busted`, `spec/`, `luacov.lua`.

| | |
|---|---|
| Test command | `busted` |
| With coverage | `busted --coverage` |
| Report step | `luacov` → `luacov.report.out` |
| Probe | `busted --list` |

`luacov.report.out` is a plain-text report the gate cannot parse. Install `luacov-cobertura` or `luacov-reporter-lcov` and configure it in `.luacov`:

```lua
reporter = "lcov"
reportfile = "coverage/lcov.info"
```

If no machine-readable reporter is available, set `coverage: "none"` and all thresholds to 0 rather than configuring a path the gate will fail to read.

## Gotchas

- **`bundle exec` / `vendor/bin/` are not optional.** Bare `rspec` or `phpunit` picks up whatever is installed globally, which is a different version than the project pins.
- **PHP coverage silently produces nothing without a driver.** The warning scrolls past; the missing report is what you notice.
- **SimpleCov's default format measures neither functions nor branches.** Set those thresholds to 0, or install the Cobertura formatter and `enable_coverage :branch`.
- **SimpleCov merges results across runs within a time window.** Two lanes running close together can merge into one `.resultset.json`, inflating both. Set `SimpleCov.command_name` per lane and give each lane its own output path.
- **Rails system specs need a browser driver.** They belong on `["push"]` with a `setupCommand` that starts whatever they need.
- **Devel::Cover's overhead is severe.** Run the coverage lane separately from the fast unit lane.
