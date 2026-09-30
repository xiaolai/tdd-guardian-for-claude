# .NET — C#, F#, VB.NET

## Detection

`*.csproj` (C#), `*.fsproj` (F#), `*.vbproj` (VB.NET), `*.sln`/`*.slnx`, `Directory.Build.props`, `global.json` (pins the SDK version).

A test project is one referencing `Microsoft.NET.Test.Sdk`. Runner comes from its other package references:

| Package | Runner |
|---------|--------|
| `xunit`, `xunit.v3` | xUnit |
| `NUnit` | NUnit |
| `MSTest.TestFramework` | MSTest |
| `TUnit` | TUnit |

`dotnet test` drives all of them identically, so the runner rarely changes the lane.

## Commands

| | |
|---|---|
| Test command | `dotnet test` |
| With coverage | `dotnet test --collect:"XPlat Code Coverage"` |
| Summary path | `TestResults/<guid>/coverage.cobertura.xml` (format: `cobertura`) |
| Probe | `dotnet test --list-tests` |

The GUID directory is the single most annoying thing about .NET coverage — the path is not stable, so it cannot be written into config as-is. Pin it:

```
dotnet test --collect:"XPlat Code Coverage" --results-directory ./coverage
```

which still nests under a GUID. The reliable fix is to configure coverlet's MSBuild integration instead, which writes exactly where you tell it:

```
dotnet test /p:CollectCoverage=true /p:CoverletOutputFormat=cobertura /p:CoverletOutput=./coverage/coverage.cobertura.xml
```

Use that form for the lane. `coverageSummaryPath` then becomes `coverage/coverage.cobertura.xml`.

`XPlat Code Coverage` requires `coverlet.collector`; the MSBuild form requires `coverlet.msbuild`. Both are NuGet packages on the test project — neither ships with the SDK.

## Lane splitting

.NET has no naming convention equivalent to Maven's Surefire/Failsafe split. Lanes come from either separate test projects or trait filters:

| Approach | Unit lane | Integration lane |
|----------|-----------|------------------|
| Separate projects | `dotnet test tests/Unit` | `dotnet test tests/Integration` |
| xUnit traits | `dotnet test --filter "Category!=Integration"` | `dotnet test --filter "Category=Integration"` |
| NUnit categories | `dotnet test --filter "TestCategory!=Integration"` | `dotnet test --filter "TestCategory=Integration"` |

Separate projects are the more common convention and give each lane its own coverage output for free.

`Microsoft.AspNetCore.Mvc.Testing` (`WebApplicationFactory`) in a project's references marks it as an integration lane — it boots a real host.

## Mutation testing

| | |
|---|---|
| Tool | Stryker.NET |
| Install | `dotnet tool install -g dotnet-stryker` |
| Command | `dotnet stryker` |
| Report | `StrykerOutput/<timestamp>/reports/mutation-report.json` |

The timestamped directory has the same instability problem as the coverage GUID; set `--output` to pin it.

## Preflight

`dotnet build --no-restore -warnaserror` is a good preflight — it catches nullable-reference and analyzer warnings that the test suite does not.

## Gotchas

- **`dotnet test` restores and builds by default.** On a warm build that is fine; cold, it is minutes. Use `--no-build` in a lane only when a preflight already built.
- **The coverage output path contains a GUID.** Use the coverlet MSBuild form to pin it, or the gate cannot find the report.
- **`--collect` and `/p:CollectCoverage` are different integrations.** Mixing them produces two reports and confusion; pick one.
- **A solution with more than one test project writes one report per project.** Either merge them with `dotnet-coverage merge`, or make one lane per project with distinct paths.
- **`--filter` syntax differs per runner.** xUnit uses `Category`, NUnit uses `TestCategory`, MSTest uses `TestCategory`. Check which runner before writing the filter.
- **F# projects list files in compile order in the `.fsproj`.** A test file missing from that list is silently not compiled and therefore not run — a zero-test lane that looks green. The gate catches this as `no-tests`.
