# SKILL.md — cli-anything-aseprite

Agent skill for **drawing pixel art like a human artist** through the
`cli-anything-aseprite` CLI, with every stroke visible in the terminal
so a human can watch the AI work in real time.

## 1. When to use

Use this skill when the user wants pixel art / sprites / game art /
icon art / animation frames. The CLI works headless (no GUI, no
Aseprite binary required): the state model, drawing primitives, PNG/GIF
export and native `.aseprite` file writing are all implemented in
Python. If a real `aseprite` executable exists, it is used for extra
batch conversions.

## 2. Mental model

A pixel sprite is a small grid (16x16, 32x32, 64x64) with a **limited
palette**. Humans do NOT paint 1024 individual pixels randomly; they
work in passes:

1. **Plan** — choose canvas size, choose a classic palette (pico8,
   db16, sweetie16, na16), sketch the silhouette in your head.
2. **Block-in** — rectangles/lines for the main shapes.
3. **Outline** — dark outline around the silhouette.
4. **Base fill** — fill each region with its main color.
5. **Shading** — darker shade on the shadow side (usually bottom/left),
   lighter shade on the light side (top/right).
6. **Highlight** — small bright pixels on the lightest spots.
7. **Details & polish** — eyes, edges, cleanup; then quantize to the
   palette if you drifted.

Every pass is a few CLI commands. **Do not flood-fill the background
until the subject is finished.**

## 3. CLI quick reference

All commands accept `--json` for machine output; state persists in the
project file (`.pxa`) plus a `.history.json` sidecar for undo.

```
cli-anything-aseprite --file art.pxa project new name --width 32 --height 32 --palette pico8
cli-anything-aseprite --file art.pxa pixel rect X Y W H COLOR [--fill]
cli-anything-aseprite --file art.pxa pixel line X0 Y0 X1 Y1 COLOR
cli-anything-aseprite --file art.pxa pixel ellipse CX CY RX RY COLOR [--fill]
cli-anything-aseprite --file art.pxa pixel set X Y COLOR
cli-anything-aseprite --file art.pxa pixel flood X Y COLOR [--tolerance N]
cli-anything-aseprite --file art.pxa pixel erase X Y [--radius N]
cli-anything-aseprite --file art.pxa undo | redo
cli-anything-aseprite --file art.pxa palette list | palette apply pico8
cli-anything-aseprite --file art.pxa palette nearest COLOR   # map to palette
cli-anything-aseprite --file art.pxa palette quantize        # snap all pixels
cli-anything-aseprite --file art.pxa layer list|add|set|property ID visible|opacity
cli-anything-aseprite --file art.pxa frame add [--blank] --duration 100
cli-anything-aseprite --file art.pxa export png out.png --scale 8
cli-anything-aseprite --file art.pxa export gif anim.gif
cli-anything-aseprite --file art.pxa export aseprite out.aseprite   # native format!
cli-anything-aseprite --file art.pxa terminal               # ANSI frame for humans
```

## 4. Human-watchable workflow

After **every** mutation run `terminal` and display the ANSI frame.
That is the "live view" — the human sees each stroke appear. In a
plugin/chat setting, forward the frame to the user with a one-line
description of what you just did.

## 5. Drawing guidelines (the "human way")

- **Small canvas first**: 16x16 for icons, 32x32 for sprites. Bigger is
  NOT better; pixel art reads best at small sizes.
- **Palette discipline**: pick ONE classic palette; prefer `palette
  nearest` over inventing hex colors; `palette quantize` as a final
  cleanup.
- **Symmetry**: draw one side, then `transform apply flip-h` for
  mirrored characters.
- **Anti-aliasing**: a single mid-tone pixel between two colors beats
  jagged edges.
- **Outlines**: dark outline (palette's darkest shade) 1px thick.
- **Eyes**: 2px wide, 2px apart, 1px dark pupil — the classic look.
- **Read before writing**: use `region get X Y W H` (or `pixel get`) to
  inspect the current state before each stroke pass.
- **Undo often**: if a pass looks wrong, `undo` and retry — a human
  would.
- **Never brute-force pixels**: prefer rect/line/ellipse/flood
  primitives, then touch individual pixels for details.
