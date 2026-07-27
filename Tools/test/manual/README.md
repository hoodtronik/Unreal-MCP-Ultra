# Manual tests

Scripts here are **not** part of `npm test`. They need a real UE editor running with the plugin
loaded (the automated suite spawns a headless commandlet with `-nullrhi`, which has no render
device), so they cannot run in CI and must be invoked deliberately.

## `vision-e2e.mjs`

End-to-end check of `vision_mode` through a **real MCP client over stdio**, driving the compiled
`dist/index.js` exactly as Claude Code would.

This exists because the auto-attach wrapper lives in `index.ts` and wraps `server.tool` at
registration time — it only exists inside a live server process, so no unit test can reach it. It
earned its place immediately: it caught that `vision_mode`'s own liveness probe was recording its
digest, which suppressed the *first* auto-attached frame after enabling the feature. Turning vision
mode on appeared to do nothing, and every component test passed regardless.

It also compares the live tool count against the source, which is how three permanently
unregistered tools (`set_actor_mobility`, `set_actor_visibility`, `set_actor_physics`) were found.

### Running it

1. Open a project with the plugin in the UE editor and wait for it to finish loading.
2. `cd Tools && npm run build`
3. `node test/manual/vision-e2e.mjs`

It edits the level it opens (spawns and deletes probe lights, changes the view mode), so point it
at a scratch project rather than anything precious. Adjust `PROJECT_DIR` at the top of the file.

Expected: all checks pass. A failure on "mutating tool -> image auto-attached" means the wrapper
is not firing; a failure on "repeat with no visual change -> suppressed" means digest suppression
has regressed.
