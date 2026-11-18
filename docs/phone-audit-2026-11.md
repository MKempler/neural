# Phone UI audit, November 2026

Checked at 390px portrait and 844px landscape (iPhone 13 emulation) against a demo hub with made-up sessions,
messages, usage readings, jobs and attachments: Home, usage meter, Sessions, timeline, session chat, long messages,
code blocks, tables, links, activity log, search, Jobs, New session, session switcher, model sheet, quick replies,
composer with attachments and long text, lightbox. No page-level horizontal scroll and no page errors anywhere.

## Fixed

- be9f3de: landscape on a notched iPhone keeps content clear of the notch (left/right safe-area insets), and on
  touch screens the code Copy button sits in its own strip instead of covering the first code line.
- Lightbox on phones: the file name, size and "2 of 3" counter get their own row instead of being squeezed to a
  few characters by the buttons.

## Design choices, not changed

1. The crash or startup error banner on a session page takes about a quarter of a 390px screen. It could shorten
   the path or collapse to one line with a tap to expand.
2. A long session name wraps the session header to two lines, and the composer placeholder ("Message <name>")
   wraps too, making the composer taller. The title could ellipsize and the placeholder could be shorter.
3. The "..." session menu button in the header is very faint at phone size.
4. Home "Needs you" cards: the action buttons (Terminal, Start) wrap onto their own row, so the card is tall.
5. Timeline and chat show no per-message times on phone apart from the grouped gutters. Confirm this is intended.
6. The "Edit quick replies" pencil sits at the end of the horizontally scrolling chip row, off screen on a phone
   until you scroll the row. It is easy to miss.
7. Model sheet, "Start with" section: the model row and the effort row both begin with an unlabelled "default"
   chip, so the two rows read as one list. A small label per row would help.
8. Composer: with a long typed message the text area scrolls under the attachment tiles, so a sliver of the
   previous line shows just below them. Minor.

## Not testable in emulation

The on-screen keyboard covering the input. Reviewed web/src/viewport.js instead: the app is sized to the visual
viewport, the tab bar hides while the keyboard is open, and a stuck viewport after the keyboard closes is
re-measured. Nothing wrong found by reading; worth a check on a real phone.
