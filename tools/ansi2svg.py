#!/usr/bin/env python3
"""Turn a frame of fleet.ts output (ANSI, 24-bit colour) into an SVG.

Usage: COLUMNS=150 LINES=44 bun demo.ts --once | python3 tools/ansi2svg.py > docs/screenshot.svg
"""
import html
import re
import sys

CW, CH, PAD = 8.4, 18, 14
BG, FG = "#0d1117", "#c6cdd7"
SGR = re.compile(r"\x1b\[([0-9;]*)m")


def cells(line):
    """Yield (char, fg, bg, bold) for each visible character of a line."""
    fg, bg, bold = FG, None, False
    pos = 0
    for m in SGR.finditer(line):
        for ch in line[pos:m.start()]:
            yield ch, fg, bg, bold
        pos = m.end()
        p = [int(x) for x in m.group(1).split(";") if x] or [0]
        i = 0
        while i < len(p):
            c = p[i]
            if c == 0:
                fg, bg, bold = FG, None, False
            elif c == 1:
                bold = True
            elif c == 22:
                bold = False
            elif c == 39:
                fg = FG
            elif c == 49:
                bg = None
            elif c in (38, 48) and p[i + 1:i + 2] == [2]:
                colour = "#%02x%02x%02x" % tuple(p[i + 2:i + 5])
                if c == 38:
                    fg = colour
                else:
                    bg = colour
                i += 4
            i += 1
    for ch in line[pos:]:
        yield ch, fg, bg, bold


lines = [l for l in sys.stdin.read().split("\n")]
while lines and not lines[-1].strip():
    lines.pop()
rows = [list(cells(l)) for l in lines]
cols = max(len(r) for r in rows)
w, h = cols * CW + PAD * 2, len(rows) * CH + PAD * 2
out = [
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.0f} {h:.0f}" width="{w:.0f}" height="{h:.0f}" '
    f'font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="14">',
    f'<rect width="100%" height="100%" rx="10" fill="{BG}"/>',
]
for y, row in enumerate(rows):
    top = PAD + y * CH
    x = 0
    while x < len(row):  # runs of identical style
        ch, fg, bg, bold = row[x]
        end = x
        while end < len(row) and row[end][1:] == (fg, bg, bold):
            end += 1
        text = "".join(c[0] for c in row[x:end])
        if bg:
            out.append(f'<rect x="{PAD + x * CW:.1f}" y="{top}" width="{(end - x) * CW:.1f}" height="{CH}" fill="{bg}"/>')
        if text.strip():
            weight = ' font-weight="700"' if bold else ""
            out.append(
                f'<text x="{PAD + x * CW:.1f}" y="{top + CH - 5}" fill="{fg}"{weight} textLength="{(end - x) * CW:.1f}" '
                f'lengthAdjust="spacingAndGlyphs" xml:space="preserve">{html.escape(text)}</text>'
            )
        x = end
out.append("</svg>")
print("\n".join(out))
