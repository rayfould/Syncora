# Global Syncora routing

On the first Syncora activation in each chat, load the installed `syncora`
skill and complete its mandatory read-only `update-status` gate before any
other Syncora operation. If it is outdated, show the installed and available
versions plus the exact scope-aware update command and explicitly ask the owner
to update; a passive warning is insufficient. If the request already asks to
update Syncora, run that command without asking again. Surface an unknown
result and never auto-update.

For the current workspace, first check whether `.syncora/config.json` exists.
If it does not, do not use Syncora for ordinary work; only explicit setup,
adoption, update, repair, removal, or diagnostics may activate it.

If the workspace is initialized, separate retrieval from capture:

1. Before work, decide whether existing project memory is needed. Use the
   installed `syncora` skill and its bounded checkpoint/context flow only when
   the request depends on project state or is plausibly project-relevant.
   Self-contained work skips retrieval and proceeds normally.
2. Before every final response, regardless of the retrieval choice, inspect
   the completed work and durable outcomes established in the conversation
   since the last successful capture. Classify the result internally as
   `durable_change`, `open_question`, or `no_durable_change`.
3. For `durable_change` or `open_question`, use Syncora's exact-owner,
   autonomous non-dry `capture` flow through `state: "applied"` before
   responding. Never ask whether to save memory or expose proposal/artifact
   digests. For `no_durable_change`, run no Syncora command.

Syncora runs only during the active request. It has no daemon, timer, watcher,
or after-final worker.
