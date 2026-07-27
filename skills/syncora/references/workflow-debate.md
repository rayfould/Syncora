# Debate workflow

Use this Syncora-owned workflow to pressure-test one proposal before
implementation.

## Execution

1. Establish the proposal, intended outcome, constraints, and current
   confidence. Inspect available project evidence before asking the user for
   facts the workspace can answer.
2. Build a decision tree internally. Ask exactly one question per turn,
   starting with the decision on which later branches depend most.
3. Include a recommended answer and concise rationale with every question.
   Let the user's answer change the remaining branches.
4. After the main position is coherent, steelman the strongest alternative.
   Test failure modes, second-order effects, reversibility, and the cost of
   being wrong.
5. Continue until the user and agent share an explicit understanding. Do not
   implement while the debate is active.
6. End with one verdict: `proceed`, `revise`, `test first`, `defer`, or
   `reject`.

## Output

Return a decision brief of no more than 200 words containing:

- recommendation and intended outcome;
- material tradeoffs;
- strongest counter-position;
- risks and rollback;
- evidence still needed;
- genuine open decisions only.
