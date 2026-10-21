#!/usr/bin/env python3
"""Stitch a gaming.tools map tile pack (.gtpk, saved from your own browser)
into one picture, its sharpest zoom: for the World Map, personal use.

    python3 -I tools/gtpk_stitch.py world_d_a.gtpk altgard.webp
    python3 -I tools/gtpk_stitch.py world_l_a.gtpk verteron.webp 12288

The optional size shrinks the picture to that width: a WebP can be at most
16383 pixels wide, and the map window holds the whole picture in memory
(4 bytes a pixel).

A pack: "GTPK", version, tile count, tile size, 0, deepest zoom, width,
height, index entry size, index offset; then per tile (zoom, column, row,
offset low, offset high, length), each tile a WebP.
"""
import io
import struct
import sys

from PIL import Image


def stitch(pack: bytes) -> Image.Image:
    if pack[:4] != b"GTPK":
        sys.exit("not a .gtpk tile pack")
    _ver, count, tile, _, deepest, width, height, entry, index = struct.unpack_from("<9I", pack, 4)
    out = Image.new("RGB", (width, height))
    missing = 0
    for i in range(count):
        zoom, col, row, lo, hi, size = struct.unpack_from("<6I", pack, index + i * entry)
        if zoom != deepest:
            continue
        at = lo | hi << 32
        if pack[at:at + 4] != b"RIFF":
            # Saved from the browser's cache: only the tiles it had loaded.
            missing += 1
            continue
        out.paste(Image.open(io.BytesIO(pack[at:at + size])).convert("RGB"), (col * tile, row * tile))
    if missing:
        sys.exit(f"{missing} tiles missing: save the pack again, bypassing the cache")
    return out


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    image = stitch(open(sys.argv[1], "rb").read())
    if len(sys.argv) == 4:
        width = int(sys.argv[3])
        image = image.resize((width, round(image.height * width / image.width)), Image.LANCZOS)
    image.save(sys.argv[2], quality=88, method=4)
    print(f"{sys.argv[2]}: {image.width}x{image.height}")
