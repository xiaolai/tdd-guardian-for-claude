---
name: mutation-gate
description: Validate test strength with mutation testing and harden weak assertions.
---

# Mutation Gate

## Requirements

1. Run mutation command when `requireMutation=true`.
2. Treat surviving mutants as test-quality defects.
3. Strengthen assertions and scenario coverage until threshold is met.

The mutation command's exit code determines pass/fail. A zero exit code means the mutation score meets the tool's configured threshold; non-zero means it does not.
