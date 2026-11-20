"""Difference matting against an inpainted background plate.

Usage: matte.py <plate_src_frame> <frames_dir> <out_dir> [preview.png]
Writes RGBA PNGs (straight alpha) to out_dir.
"""
import os
import sys
import cv2
import numpy as np
from scipy import ndimage as ndi
from analyze import fit_bg

T0, T1 = 7.0, 26.0  # distance ramp: <=T0 transparent, >=T1 opaque


def make_plate(frame):
    img = frame.astype(float)
    bg = fit_bg(img)
    d = np.sqrt(((img - bg) ** 2).sum(-1))
    # The robot is textured (part seams, joints, glowing lines); the backdrop
    # and its floor light-pool are smooth. Mask by texture, not brightness,
    # so the floor stays in the plate.
    lum = cv2.GaussianBlur(img.mean(-1), (0, 0), 1.0)
    grad = np.hypot(cv2.Sobel(lum, cv2.CV_64F, 1, 0), cv2.Sobel(lum, cv2.CV_64F, 0, 1))
    texture = cv2.GaussianBlur(grad, (0, 0), 3)
    sat = img.max(-1) - img.min(-1)
    seed = ((d > 14) & (texture > 12)) | (img.mean(-1) < 110) | (sat > 45)
    rough = ndi.binary_closing(seed, iterations=6)
    rough = ndi.binary_fill_holes(rough)
    rough = ndi.binary_dilation(rough, iterations=8)
    plate = cv2.inpaint(frame.astype(np.uint8), rough.astype(np.uint8) * 255, 25, cv2.INPAINT_TELEA)
    return cv2.GaussianBlur(plate.astype(float), (0, 0), 6)


def matte(frame, plate):
    c = frame.astype(float)
    diff = c - plate
    d = np.sqrt((diff ** 2).sum(-1))
    a = np.clip((d - T0) / (T1 - T0), 0, 1)
    a = a * a * (3 - 2 * a)  # smoothstep

    lum = c.mean(-1)
    sat = c.max(-1) - c.min(-1)
    blum = cv2.GaussianBlur(lum, (0, 0), 1.0)
    grad = np.hypot(cv2.Sobel(blum, cv2.CV_64F, 1, 0), cv2.Sobel(blum, cv2.CV_64F, 0, 1))
    texture = cv2.GaussianBlur(grad, (0, 0), 2)

    # Solid core: textured / dark / saturated foreground (the robot's seams,
    # joints, glowing trim), closed and hole-filled so smooth white panels
    # enclosed by seams become opaque. The smooth floor pool and shadow never
    # seed the core, so they cannot be filled in.
    seed = (d > T1) & ((texture > 14) | (lum < 110) | (sat > 40))
    seed = ndi.binary_opening(seed, iterations=1)
    core = ndi.binary_fill_holes(ndi.binary_closing(seed, iterations=3))
    core_soft = cv2.GaussianBlur(core.astype(float), (0, 0), 0.8)

    # Outside the core keep only colourful partial alpha (blue glow, sparks,
    # data cloud); smooth grey residue (floor pool, shadow, haze) goes.
    colourful = np.clip((sat - 14) / 30, 0, 1)
    a = np.where(core, np.maximum(a, core_soft), np.maximum(a * colourful, core_soft))

    # Remove isolated specks of partial alpha (compression noise).
    lab, n = ndi.label(a > 0.04)
    if n:
        sizes = ndi.sum(np.ones_like(a), lab, index=np.arange(1, n + 1))
        keep = np.isin(lab, 1 + np.flatnonzero(sizes >= 40))
        a = np.where(keep, a, 0.0)

    # Un-mix colour: c = a*F + (1-a)*plate  ->  F = (c - (1-a)*plate) / a
    safe = np.maximum(a, 1e-3)[..., None]
    fg = np.clip((c - (1 - a)[..., None] * plate) / safe, 0, 255)
    fg = np.where(a[..., None] > 0.995, c, fg)
    return np.dstack([fg, a * 255]).round().astype(np.uint8)


def composite(rgba, bg):
    a = rgba[..., 3:4] / 255.0
    return (rgba[..., :3] * a + bg * (1 - a)).astype(np.uint8)


if __name__ == "__main__":
    plate_src, frames_dir, out_dir = sys.argv[1:4]
    preview = sys.argv[4] if len(sys.argv) > 4 else None
    os.makedirs(out_dir, exist_ok=True)
    plate = make_plate(cv2.cvtColor(cv2.imread(plate_src), cv2.COLOR_BGR2RGB))
    names = sorted(f for f in os.listdir(frames_dir) if f.endswith(".png"))
    samples = []
    for i, name in enumerate(names):
        rgb = cv2.cvtColor(cv2.imread(os.path.join(frames_dir, name)), cv2.COLOR_BGR2RGB)
        rgba = matte(rgb, plate)
        cv2.imwrite(os.path.join(out_dir, name), cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
        if i in (0, len(names) // 4, len(names) // 2, 3 * len(names) // 4):
            samples.append(rgba)
    if preview:
        h, w = samples[0].shape[:2]
        dark = np.zeros((h, w, 3)); dark[:] = (15, 7, 32)
        panel = np.zeros((h, w, 3)); panel[:] = (17, 24, 39)
        yy, xx = np.mgrid[0:h, 0:w]
        checker = np.where(((yy // 20 + xx // 20) % 2)[..., None] == 0, 200, 120) * np.ones(3)
        rows = [np.hstack([composite(s, b) for s in samples]) for b in (dark, panel, checker)]
        cv2.imwrite(preview, cv2.cvtColor(np.vstack(rows), cv2.COLOR_RGB2BGR))
        print("plate corners", plate[0, 0].round(), plate[-1, -1].round(), "center", plate[280, 280].round())
