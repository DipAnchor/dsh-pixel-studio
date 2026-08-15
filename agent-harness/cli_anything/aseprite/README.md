# cli-anything-aseprite

CLI harness for the [Aseprite](https://www.aseprite.com) pixel-art editor,
built with the [CLI-Anything](https://github.com/HKUDS/CLI-Anything)
methodology: an agent-usable, stateful, JSON-emitting CLI that lets AI
agents draw pixel art "like a human" — one deliberate stroke at a time —
while a human watches the canvas render live in the terminal.

## Features

- **Stateful project model** (`.pxa`, JSON): layers, frames, palette,
  current layer/frame, undo/redo stacks persisted in a sidecar.
- **Human drawing vocabulary**: pixel, line (Bresenham), rectangle,
  ellipse (midpoint), flood fill with tolerance, eraser, region read /
  invert, flip & rotate transforms.
- **Classic palettes**: pico8, db16, sweetie16, na16 + nearest-color
  quantization.
- **Animation**: multi-frame documents, per-frame duration, GIF export.
- **Exports**: PNG (nearest-neighbor upscale), animated GIF, sprite
  sheet PNG+JSON, and **native `.aseprite` binary** (hand-written ASE
  format writer — open the result in the real Aseprite editor).
- **Real-time terminal frames**: `terminal` renders the canvas as an
  ANSI truecolor half-block frame; run it after every stroke so humans
  watch the AI draw live.
- **Optional real-binary backend**: if `aseprite` is on PATH (or
  `ASEPRITE_BIN` set), `backend info` reports it; the harness remains
  fully functional without it.
- **JSON + human output**, one-shot CLI **and** interactive REPL.

## Install

```bash
pip install -e .
```

## Usage

```bash
# create a 32x32 sprite with the pico8 palette
cli-anything-aseprite --file hero.pxa project new hero --width 32 --height 32 --palette pico8

# draw like a human: block-in, outline, fill, shade, highlight
cli-anything-aseprite --file hero.pxa pixel rect 10 6 12 18 "#1d2b53"          # outline
cli-anything-aseprite --file hero.pxa pixel rect 11 7 10 16 "#ff004d" --fill   # body
cli-anything-aseprite --file hero.pxa pixel line 10 24 16 24 "#ffa300"         # ground

# show the human the live canvas
cli-anything-aseprite --file hero.pxa terminal

# export in every format
cli-anything-aseprite --file hero.pxa export png hero.png --scale 8
cli-anything-aseprite --file hero.pxa export aseprite hero.aseprite
```

Machine-readable output is available everywhere with `--json`.

## Project layout

```
cli_anything/aseprite/
├── aseprite_cli.py        # Click CLI: subcommands + REPL
├── core/
│   ├── model.py           # document model, pixels, compositing
│   ├── canvas.py          # drawing primitives
│   ├── palette.py         # palettes + quantization
│   ├── layers.py          # layer stack
│   ├── animation.py       # frames
│   ├── export.py          # PNG/GIF/sheet + .aseprite binary writer
│   └── session.py         # undo/redo with sidecar persistence
├── utils/
│   ├── terminal.py        # ANSI real-time frame renderer
│   ├── aseprite_backend.py# real aseprite --batch wrapper (optional)
│   ├── io.py              # locked JSON save
│   └── repl_skin.py       # cli-anything REPL skin
├── tests/                 # TEST.md plan, 39 unit + 10 E2E tests
└── skills/SKILL.md        # AI pixel-art skill
```

## Tests

```bash
python -m pytest cli_anything/aseprite/tests/ -q   # 49 passing
```

## Aseprite integration

- **Native format**: the `.aseprite` writer implements the public ASE
  file spec (header, layer/palette/cel/frame-tag chunks, zlib-compressed
  cels). Files open directly in Aseprite.
- **Real binary**: when `aseprite` is available, `aseprite --batch`
  can be used for packed sprite sheets, palette conversion, dithering
  (see `utils/aseprite_backend.py`).
