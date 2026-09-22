# KNOWN ISSUE: no SwitchEnum node type in add_node / build_graph

**Symptom.** `add_node`/`build_graph` support Branch, Sequence, Select, loops — but not
`K2Node_SwitchEnum` (or SwitchInt/SwitchString). Any graph that dispatches on an enum
(e.g. a stage-preset selector) cannot be authored the way a human would build it.

**Workaround used (2026-09-01).** Chain of `EqualEqual_ByteByte` + Branch pairs — one per
enumerator. An enum VariableGet output connects to the byte `A` pin without an explicit
conversion (the K2 schema accepts enum→byte), and literal byte defaults 0..N select the case.
Built 6 presets × 4 door moves this way in BP_Walls_Graybox's construction script; compiles
clean and behaves identically to the original EventGraph's real SwitchEnum.

**Cost.** 12 extra nodes + ~1.6× the wiring for a 6-case dispatch, a graph that reads as
nested IFs instead of a switch, and no compiler protection when the enum grows (a real
SwitchEnum shows the new case; the chain silently ignores it).

**Suggested fix.** Add `nodeType: "SwitchEnum"` with an `enumName` field (asset name for
UserDefinedEnums). Spawn `UK2Node_SwitchEnum`, set its enum, let the per-case exec pins
(`NewEnumerator0..N`) be addressed in build_graph connections — the read path
(get_blueprint_graph) already serializes those pin names.
