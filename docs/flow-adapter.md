# Flow adapter: assumptions and live validation

`src/flow/` is the only code that knows how Google Flow's page is built. Everything else
talks to it through the commands listed in `src/shared/protocol.js`
(`probe`, `readSettings`, `applySettings`, `clearReferences`, `attachReferences`,
`insertPrompt`, `snapshotOutputs`, `submit`, `generationStatus`, `diagnose`).

## Status: not verified against the live Flow page

The heuristics below were written from Google's public Flow help pages (the prompt box with
the model name, Image/Video mode, Add → Upload, aspect ratio, Generate) and from common
accessibility conventions. Flow requires a signed-in Google account, so the page could not
be inspected while this code was written. Treat every row as an assumption until it passes
the checklist at the end of this document.

The unit tests and the browser harness use a synthetic page (`test/fixtures/flow-fixture.js`).
It models these assumptions. It is not a copy of Flow, so passing those tests does not prove
the live page matches.

## Heuristics and the symptom when each one is wrong

| What | How the adapter finds it | Symptom when wrong | Where |
| --- | --- | --- | --- |
| Prompt box | Visible `textarea`, or `contenteditable` / `role="textbox"`. Labels that mention prompt, describe, imagine, create or generate score higher. | "Flow prompt box not found." | `selectors.js` `findPromptBox` |
| Generate button | Visible button in the prompt's region named Generate, Create or Make. Document-wide fallback only for an explicit "Generate". | "Generate button not found." or "disabled" | `findGenerateButton` |
| Settings control | The model-name control in the prompt region (it opens the menu with Mode, Model and Aspect ratio together), then any control with `aria-haspopup`/`aria-expanded` (any tag), then settings-like names, chevrons, aspect-ratio chips and bare Image/Video words. If the prompt region holds no candidate, the document is searched, but only strong matches (model name or declared popup) are clicked there. When nothing is found, the Check Flow page report lists the controls that are near the prompt. | "Could not find the model/settings control." | `findSettingsTrigger`, `listPromptControls` |
| Settings options | Options inside an open menu, dialog or listbox. Grouped by the nearest heading (Mode, Model, Aspect ratio). Options are classified by group, then by shape (`16:9`). | Empty or wrong option lists; setting not found | `readPopoverOptions`, `classifySettingOption` |
| Agent switch | Control named "Agent" with `aria-checked` or `aria-pressed`. | Agent state not detected | `findAgentToggle` |
| Add / Upload | Button named Add, Upload or Attach near the prompt. Menu item named Upload. Then a file input. | "Could not find the Add control" or "did not open a file picker" | `findAddButton`, `findUploadMenuItem`, `findFileInput` |
| Reference chips | Remove buttons named Remove, Delete, Clear or Close inside the prompt region, plus thumbnails of 24–160 px. | Upload never confirmed → `REFERENCE_UPLOAD_FAILED`; leftovers → `REFERENCE_CLEAR_FAILED` | `countAttachedReferences`, `findReferenceRemoveButtons` |
| Outputs | `img` and `video` elements at least 96×96 px, outside the prompt region and menus. Key = `src`. | New output never seen → generation times out (fails safely) | `findOutputMedia` |
| In progress | `[role="progressbar"]` or `[aria-busy="true"]` outside the prompt region. | Completion too early if a generation shows no indicator; never completes if an unrelated spinner stays on screen | `findProgressIndicators` |
| Failure | Text of a `[role="alert"]` that was not on the page before submission. | Failure not reported → times out instead of failing fast | `findAlertTexts` |

Two safety properties do not depend on these heuristics being right:

- A scene completes only when a new output is seen, no progress indicator is active, and the
  state holds for consecutive polls and a settle window. Elapsed time alone never completes a scene.
- If an element cannot be found or verified, the step fails with a named error. The adapter never
  clicks a guessed location and never reports success it did not observe.

## Live validation checklist

Do this once on a real, signed-in Flow project before using the queue on real work.

1. Build (`npm run build`), then load `dist/` as an unpacked extension in Chrome 116 or later.
2. Open a Flow project in the active tab and open the side panel. The header should read
   **● Connected**.
3. Open **Settings → Check Flow page**. Each check should be OK:
   Flow page, Project open, Prompt box, Generate button, Settings control, Agent mode.
   Any failing check names the heuristic that needs updating (table above).
4. Press **Read from Flow**. Mode, Model and Aspect ratio should list exactly what Flow's
   settings menu shows, and the current values should match Flow.
5. Add one real reference image whose filename a one-scene document names exactly. Analyze a
   one-scene document. Press Start. Confirm, in order:
   - the prompt appears in Flow's prompt box, verbatim;
   - the reference appears as a chip in Flow;
   - Generate is clicked (progress appears in the results);
   - the queue shows Completed only after the output is visible in Flow;
   - Flow's settings are unchanged after the run, apart from what you chose.
6. Force a failure you can see in Flow, for example by leaving a required setting invalid. Confirm the
   scene shows Failed with Flow's own message, and that Retry, Skip and Stop are offered.
7. Record what you saw, including the Flow version and date, in your change notes.

## Changing a heuristic

Change only `src/flow/selectors.js` (and `dom.js` for generic helpers). Before changing it, add a
test in `test/flow-adapter.test.js` that reproduces the observed markup, so the fix is pinned.
Then run `npm test` and `npm run e2e`.
