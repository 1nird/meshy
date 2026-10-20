"""Convert the extracted WebP textures to Roblox-safe PNGs.

Usage: python convert-webp.py <extractDir>
Reads img0.webp (normal), img1.webp (albedo), img2.webp (ORM) from <extractDir>
and writes PNGs to <extractDir>/png/, downscaling anything larger than 1024px.
"""
import os
import sys
from PIL import Image

src_dir = sys.argv[1] if len(sys.argv) > 1 else "C:/Users/nirde/Music/WolverineInBackrooms/tmp-tools/w2_extract"
out_dir = os.path.join(src_dir, "png")
os.makedirs(out_dir, exist_ok=True)

MAX = 1024
for i in range(3):
    src = os.path.join(src_dir, f"img{i}.webp")
    if not os.path.exists(src):
        print(f"img{i}.webp missing, skipping")
        continue
    with Image.open(src) as im:
        im.load()
        w, h = im.size
        mode = im.mode
        if max(w, h) > MAX:
            s = MAX / max(w, h)
            im = im.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)
        dst = os.path.join(out_dir, f"img{i}.png")
        im.save(dst, "PNG")
        print(f"img{i}: {w}x{h} {mode} -> {im.size[0]}x{im.size[1]} PNG ({os.path.getsize(dst)} bytes)")
print("done ->", out_dir)
