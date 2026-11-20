import sys
import numpy as np
from PIL import Image

def fit_bg(img, band=36):
    """Quadratic surface per channel fitted to the border band (robust: 2 passes)."""
    h, w, _ = img.shape
    yy, xx = np.mgrid[0:h, 0:w]
    m = np.zeros((h, w), bool)
    m[:band] = m[-band:] = True
    m[:, :band] = m[:, -band:] = True
    X = np.stack([np.ones(h*w), xx.ravel()/w, yy.ravel()/h, (xx.ravel()/w)**2, (yy.ravel()/h)**2, (xx.ravel()*yy.ravel())/(w*h)], 1)
    bg = np.zeros_like(img, dtype=float)
    for c in range(3):
        sel = m.ravel().copy()
        for _ in range(3):
            coef, *_ = np.linalg.lstsq(X[sel], img[..., c].ravel()[sel], rcond=None)
            pred = X @ coef
            resid = np.abs(img[..., c].ravel() - pred)
            sel = m.ravel() & (resid < 6)
        bg[..., c] = pred.reshape(h, w)
    return bg

if __name__ == "__main__":
    f = sys.argv[1]
    img = np.asarray(Image.open(f).convert("RGB")).astype(float)
    bg = fit_bg(img)
    d = np.sqrt(((img - bg) ** 2).sum(-1))
    print("bg corners", bg[0,0].round(), bg[-1,-1].round(), "bg center", bg[280,280].round())
    for t in [6, 10, 14, 20, 30]:
        print(f"dist>{t}: {(d>t).mean()*100:.1f}% of pixels")
    # visualize: dist map and thresholds
    vis = np.clip(d * 4, 0, 255).astype(np.uint8)
    Image.fromarray(vis).save(sys.argv[2])
    lum = img.mean(-1); blum = bg.mean(-1)
    # brighter-than-bg vs darker-than-bg map
    sgn = np.zeros(img.shape, np.uint8)
    sgn[..., 0] = np.clip((blum - lum) * 6, 0, 255)   # darker = red
    sgn[..., 2] = np.clip((lum - blum) * 6, 0, 255)   # brighter = blue
    Image.fromarray(sgn).save(sys.argv[3])
