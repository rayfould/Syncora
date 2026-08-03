# Debate workflow

Use this Syncora-owned workflow to run a relentless adaptive decision interview
and pressure-test one proposal before implementation. Be relentless about the
idea, never hostile toward the user.

## Execution

1. Establish the proposal, intended outcome, constraints, and current
   confidence. Inspect available project evidence before asking the user for
   facts the workspace can answer.
2. Build a private coverage map across the material dimensions of the choice:
   outcome and user, evidence and assumptions, alternatives and opportunity
   cost, feasibility and dependencies, cost and maintenance, failure and abuse
   cases, reversibility, and success criteria. Do not dump this checklist on
   the user or ask about dimensions that do not matter.
3. Ask exactly one atomic question per turn. Choose the unresolved question
   with the highest information value: the answer most likely to change the
   recommendation or eliminate later branches. State briefly why it matters,
   then include a recommended answer and concise rationale. Never batch
   questions.
4. Treat each answer as evidence, not automatic closure. If it is vague,
   contradictory, unsupported, or merely restates the goal, challenge it with
   a targeted follow-up. Ask what must be true, what evidence would distinguish
   the options, or what breaks under the answer. Do not accept hand-waving to
   keep the conversation comfortable.
5. Let every answer reshape the decision tree. Surface hidden constraints and
   force material tradeoffs instead of allowing incompatible benefits to remain
   simultaneously assumed. Convert `I don't know` into an explicit assumption,
   evidence request, or smallest useful test.
6. Once the main position is coherent, steelman the strongest alternative and
   run a premortem. Test failure modes, second-order effects, abuse paths,
   reversibility, and the cost of being wrong.
7. Continue until each material uncertainty is resolved, explicitly accepted
   as an assumption, assigned to a test, or retained as a genuine decision.
   If the user stops early, return a partial verdict with the unresolved gaps.
   Do not implement while the debate is active.
8. End with one verdict: `proceed`, `revise`, `test first`, `defer`, or
   `reject`, plus a calibrated confidence level.

During the interview, keep each turn short: only the context needed for the
next question, the reason it matters, the recommendation, and that one
question. Do not repeatedly summarize the whole debate.

## Output

Return a decision brief of no more than 200 words containing:

- recommendation and intended outcome;
- verdict and calibrated confidence;
- material tradeoffs;
- strongest counter-position;
- risks and rollback;
- assumptions and evidence still needed;
- tests required before commitment;
- genuine open decisions only.
