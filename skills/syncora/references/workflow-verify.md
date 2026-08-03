# Verify workflow

Use this Syncora-owned workflow before claiming that work is complete, fixed,
passing, or ready to release.

## Execution

1. When a WorkPack exists, treat its predeclared design contracts and task
   acceptance criteria as the primary completion contract. Do not rewrite them
   after implementation. When no WorkPack exists, translate the claim into
   observable acceptance criteria.
2. Map every criterion to the full command, inspection, or reproducible
   scenario that would prove it.
3. Run every available check fresh during the active request. Read the complete
   output and exit status. An earlier pass, a partial command, or another
   agent's report is not current proof.
4. Inspect relevant negative paths, boundary cases, regressions, and
   user-visible behavior. Match the verification method to the claim: a linter
   does not prove a build, and unit tests do not prove a browser flow.
5. Classify every criterion as `proven`, `disproven`, `blocked`, or `untested`.
   Never upgrade partial evidence.
6. For WorkPack verification, write durable evidence under that pack's
   `evidence/<run-id>/` directory and verify that every completed task has a
   truthful handoff. Independent regression, security, and boundary checks may
   add evidence, but they may not weaken or replace the original contract.

## Output

Return:

- the claim and acceptance criteria;
- an evidence matrix with the exact check, result, and relevant evidence;
- negative and boundary checks;
- untested or blocked claims;
- regressions found;
- one verdict: `proven`, `partially proven`, or `disproven`;
- the smallest next action for every gap.
