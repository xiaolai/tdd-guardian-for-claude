---
name: mutation-gate
description: Validate test strength with mutation testing and harden weak assertions.
---

# Mutation Gate

## Requirements

1. Run mutation command when `requireMutation=true`.
2. Treat surviving mutants as test-quality defects.
3. Strengthen assertions and scenario coverage until threshold is met.

Default initial target: `>=85%` mutation score, then ratchet upward.
