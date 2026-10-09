# How the extension works, step by step

This is what the extension actually does, in order. Nothing here is aspirational —
each step maps to code in `src/`.

## 0. Before a run

1. **You load scenes** (CSV / manual entry) into the side panel. Each scene has a
   prompt, optional reference image files, and the settings it wants (mode, model,
   aspect ratio, output count).
2. **You open Flow** in a tab, on a project page (`flow.google.com/project/...`).
3. The background **connector** injects the content script into that tab and asks it
   "are you there?". The side panel shows six separate states — Flow tab detected,
   content script responding, Flow project detected, prompt composer detected,
   settings read, ready for automation. It never says Ready unless all of them hold.

## 1. Per run, once

4. **Find the prompt composer.** Not by a CSS class — by what it is: a visible,
   enabled text field inside the region that also holds the Add control, the model
   chip and the generate button. Candidates that are page furniture (header, search,
   sidebar) are rejected and the report says why.
5. **Check Agent mode.** If Flow's Agent chip is pressed, the classic composer is
   hidden and the generation settings do not exist. The extension turns Agent off
   (one click, then verifies) or stops and tells you.

## 2. Per scene

6. **Read Flow's current settings.** Click the settings trigger (the model chip),
   wait for a menu that *the click actually opened*, and read its rows: Mode,
   Aspect ratio, output count, and the model list (often behind a "Select model
   family" submenu). The model chip text is cross-checked against the menu.
   - If the surface that appears is not the generation menu (a snackbar, a library
     panel), it is rejected and the next candidate control is tried.
   - If a control is not offered in the active mode, that is recorded as
     *not offered* — never faked, and no longer a scene failure.
7. **Apply the scene's settings** — only the ones that differ from what Flow already
   shows. Each change is verified twice: the menu's selected row, and the chip text.
8. **Attach the reference images** ("Ingredients" in Flow's language). This is the
   step that has been failing; see below.
9. **Insert the prompt** into the composer (as a real input event, so Flow's editor
   registers it), then verify the composer actually contains it.
10. **Press Generate**, and wait for Flow to accept the submission.
11. **Wait for the output** to appear, record it against the scene, then move to the
    next scene. One scene at a time — never in parallel.

## 3. When something goes wrong

- Recoverable problems get **one automatic retry**.
- Problems only you can fix (Agent mode stuck, references refused, a menu that is
  not Flow's) **pause** the run with a decision: Resume / Skip / Stop. Nothing is
  submitted while paused, so a scene is never generated without its references.
- Everything that cannot be determined is shown as `Unknown` with the reason, and
  "Check Flow page" prints the full evidence.

## Step 8 in detail: why references are hard here

Flow exposes **no `input[type=file]`** anywhere — not in the page, its shadow roots
or its frames. Its "Upload" item raises the **operating system file dialog**, which
no extension can fill. So the extension tries, in order:

1. a file input, if one ever appears;
2. opening Flow's Add menu and looking again;
3. a synthetic **drag-and-drop** onto the composer / prompt box / body;
4. a synthetic **paste** into the composer.

If none of them produces a verified ingredient chip, the run **pauses** and asks you
to attach the files by hand, then reuses your own chips on Resume.
