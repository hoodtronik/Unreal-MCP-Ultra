# KNOWN ISSUE: `capture_view` ignores its camera and returns the current viewport (UE 5.8.3)

**Status:** open. Found 2026-09-23 in MyLab_5_8 (UE 5.8.3-58210709), plugin built from `main`
(dual-engine tree). Not yet checked on 5.6.1.

## Symptom

`capture_view` accepts `location` / `lookAt` (or a `cameraActor`) and reports a plausible result —
`"Captured 1280x720 (editor world)"` plus a written PNG — but the returned image is the **current
editor viewport**, not a render from the requested camera.

## How it was proven

The parameters were ignored *silently*, so the first test looked like a success:

1. Viewport locked to a shot camera at `(500, 0, 165)` yaw 180. `capture_view` was then asked for the
   opposite side, `(-500, 0, 165)` looking back at the subject. It returned an image **pixel-identical
   to the locked viewport** — a front view and a back view of a human figure cannot be identical.
2. The camera cut was then unlocked, leaving the viewport on a free camera at ground level showing
   something completely different. The *same* `capture_view` call was repeated, and it returned that
   new ground-level frame.

Two different viewport states, two matching `capture_view` results, zero influence from the camera
arguments. That is the whole diagnosis.

## Why it matters

This is the failure mode that wastes the most time: the tool does not error, and the image it returns
is a *real render of the level*, so it reads as a legitimate answer to a question that was never asked.
It was briefly taken as evidence that a correctly-posed character was facing the wrong way.

## Workaround

Use the level sequence's own camera and the locked viewport:

```python
show_frame(seq, frame)      # previz_lib: look_through + presentation_mode + settle
```
then `viewport_capture` (or `vision_mode`, which attaches the frame automatically). Both are
trustworthy — they render what the viewport genuinely shows.

## Suggested fix

Check the C++ handler for `capture_view` (`BlueprintMCPHandlers_Screenshot.cpp`): on 5.8 it is
presumably falling through to a viewport `ReadPixels` path instead of building its own
`FSceneCaptureComponent2D`/scene view from the supplied transform. Whatever the cause, the handler
must **fail loudly** when it cannot honour the requested camera rather than returning a viewport frame,
and the response should name the camera it actually rendered from.

## Real cost

About eight tool calls and one wrong conclusion during a storyboard session, plus the risk that any
"render from an arbitrary angle" result recorded in earlier work on 5.8 is actually a viewport frame.
