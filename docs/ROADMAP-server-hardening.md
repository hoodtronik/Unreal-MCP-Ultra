# Roadmap: server hardening (ideas adopted from StraySpark comparison, 2026-08-26)

Four improvements identified by comparing against StraySpark's Unreal MCP Server v4.5.
Items 1-2 in progress; 3-4 tracked for later.

## 1. Port bind retry + `BlueprintMCP.Restart` console command — IN PROGRESS

`docs/KNOWN-ISSUE-port-bind-no-retry.md`. Subsystem retries the bind on a timer if the
port was busy at startup, and a console command restarts the server in-session.
Follow-up (not in this pass): configurable port via `-BlueprintMCPPort=` / config ini.

## 2. Background tasks for long-running operations — IN PROGRESS

`save_all` (and friends) can outlive the 120s MCP client timeout and, worse, a modal
dialog during the op freezes the single-threaded request loop while a client holds a
dead socket (both bit us on 2026-08-26). Plan: `async=1` query param on long-op
endpoints → immediate `{taskId}` response, op runs on subsequent ticks; new
`/api/task-status?id=` endpoint + `get_task_status` MCP tool; TS `save_all` polls
briefly then hands back the task id.

## 3. Auto-transaction on every mutating endpoint — ALREADY IMPLEMENTED (no work needed)

Verified 2026-08-26: `ProcessOneRequest()` already wraps every `MutationEndpoints` entry in
a named `BlueprintMCP: <endpoint>` editor transaction (widget mutations deliberately
excluded — see the World-Leak CLAUDE-NOTE at the wrap site). The comparison's premise was
wrong; nothing to build. Audit follow-up only: confirm newer mutating endpoints are all
listed in `MutationEndpoints`.

## 4. Tool scripts (multi-step batch as one transaction) — TRACKED

Generalize `build_graph`'s batching: a `/api/run-script` accepting an ordered list of
endpoint calls executed inside one transaction with one result array, partial-failure
reporting, and a single undo entry. Combines with item 3.
