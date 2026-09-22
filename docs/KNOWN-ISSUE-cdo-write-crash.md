# KNOWN ISSUE: editor AV after back-to-back set_blueprint_default calls

**Symptom.** Two `set_blueprint_default` calls against the same Blueprint issued in one
client batch (processed back-to-back by the server): the first completes fully —
log shows compile, SaveBlueprintPackage SUCCEEDED, `Set '...WireFrame' from 'True' to
'False' (saved: true)` — then the editor dies ~12 s later with
`EXCEPTION_ACCESS_VIOLATION reading 0xffffffffffffffff` before the second call answers.

**Evidence.** MyLab_5_6 log 2026-09-01: 15:55:03.559 first set OK → 15:55:15.308 AV.
(Preceded in the same session by a validate_blueprint + describe_graph on the same BP,
so the class had just been recompiled at least twice.)

**Suspected cause.** The first call's compile reinstances the Blueprint's generated class;
the second request resolves or reuses a Blueprint/CDO pointer from before reinstancing and
reads freed memory. The 0xffffffffffffffff read is characteristic of a stale `TWeakObjectPtr`
/ freed UObject dereference.

**Workaround.** Never batch multiple CDO writes to the same Blueprint; issue them one call
at a time and let each response return before the next request. (Instance-level
`set_editor_property` via run_python is unaffected and often a better tool anyway.)

**Suggested fix.** In the set_blueprint_default handler, re-resolve the Blueprint and CDO
from the asset path at the top of every request (never cache across requests), and after
compilation call `GetDefaultObject()` again from `Blueprint->GeneratedClass` before writing.
A regression test: 5 sequential CDO writes to one BP inside a single test run.
