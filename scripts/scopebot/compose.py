"""Combine Vision subject masks with a colour-only difference matte.

Usage: compose.py <plate_src_frame> <frames_dir> <masks_dir> <out_dir> [preview.png]

alpha = max(vision_mask, colourful_glow_alpha)
colour is un-mixed from the backdrop plate wherever alpha < 1, so edges carry
no light-grey fringe when shown on a dark UI.
"""
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from matte import T0, T1, composite, make_plate  # noqa: E402


def compose(rgb, mask, plate):
    c = rgb.astype(float)
    m = mask.astype(float) / 255.0
    # Tighten the soft edge a little; Vision's matte is generous by ~1px.
    m = np.clip((m - 0.08) / 0.84, 0, 1)

    d = np.sqrt(((c - plate) ** 2).sum(-1))
    ramp = np.clip((d - T0) / (T1 - T0), 0, 1)
    sat = c.max(-1) - c.min(-1)
    colourful = np.clip((sat - 16) / 30, 0, 1)
    glow = ramp * colourful

    a = np.maximum(m, glow)
    safe = np.maximum(a, 1e-3)[..., None]
    fg = np.clip((c - (1 - a)[..., None] * plate) / safe, 0, 255)
    fg = np.where(a[..., None] > 0.98, c, fg)
    a = np.where(a < 0.02, 0, a)
    return np.dstack([fg, a * 255]).round().astype(np.uint8)


if __name__ == "__main__":
    plate_src, frames_dir, masks_dir, out_dir = sys.argv[1:5]
    preview = sys.argv[5] if len(sys.argv) > 5 else None
    os.makedirs(out_dir, exist_ok=True)
    plate = make_plate(cv2.cvtColor(cv2.imread(plate_src), cv2.COLOR_BGR2RGB))
    names = sorted(f for f in os.listdir(frames_dir) if f.endswith(".png"))
    samples = []
    for i, name in enumerate(names):
        rgb = cv2.cvtColor(cv2.imread(os.path.join(frames_dir, name)), cv2.COLOR_BGR2RGB)
        mask = cv2.imread(os.path.join(masks_dir, name), cv2.IMREAD_GRAYSCALE)
        rgba = compose(rgb, mask, plate)
        cv2.imwrite(os.path.join(out_dir, name), cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
        if i in (0, len(names) // 4, len(names) // 2, 3 * len(names) // 4):
            samples.append(rgba)
    if preview:
        h, w = samples[0].shape[:2]
        dark = np.zeros((h, w, 3)); dark[:] = (15, 7, 32)
        white = np.full((h, w, 3), 255.0)
        yy, xx = np.mgrid[0:h, 0:w]
        checker = np.where(((yy // 20 + xx // 20) % 2)[..., None] == 0, 200, 120) * np.ones(3)
        rows = [np.hstack([composite(s, b) for s in samples]) for b in (dark, white, checker)]
        cv2.imwrite(preview, cv2.cvtColor(np.vstack(rows), cv2.COLOR_RGB2BGR))
