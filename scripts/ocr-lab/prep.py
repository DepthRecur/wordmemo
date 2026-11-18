"""OCR 实验台：把一张笔记照片切成若干带重叠的块，可选增强/放大。

用法:
  python prep.py <src> <outdir> --mode col|strip|page --rows 3 --overlap 0.14 --scale 2.2
输出:
  <outdir>/tiles/*.jpg   切片
  <outdir>/manifest.json 切片顺序与位置说明
"""
import argparse
import json
import os

import numpy as np
from PIL import Image, ImageFilter, ImageOps

TARGET_AREA = 2_600_000  # 接近单图 ~1024 token 的面积上限，吃满视觉预算


def load(path):
    im = Image.open(path)
    im = ImageOps.exif_transpose(im)
    return im.convert('RGB')


def paper_box(im):
    """估计纸张区域，去掉深色卡纸/桌面边缘。"""
    small = im.convert('L')
    w, h = small.size
    sw = 400
    sh = max(1, int(h * sw / w))
    s = np.asarray(small.resize((sw, sh), Image.BILINEAR), dtype=np.float32)
    bright = s > 110
    rows = np.where(bright.mean(axis=1) > 0.45)[0]
    cols = np.where(bright.mean(axis=0) > 0.45)[0]
    if len(rows) < 10 or len(cols) < 10:
        return (0, 0, w, h)
    y0, y1 = int(rows[0] * h / sh), int((rows[-1] + 1) * h / sh)
    x0, x1 = int(cols[0] * w / sw), int((cols[-1] + 1) * w / sw)
    # 稍微内缩，避开纸张边缘阴影
    pad_x, pad_y = int((x1 - x0) * 0.01), int((y1 - y0) * 0.01)
    return (x0 + pad_x, y0 + pad_y, x1 - pad_x, y1 - pad_y)


def gutter(im, box):
    """在纸张中部找装订/栏间空白，返回分栏 x 坐标（相对纸张），找不到返回 None。"""
    x0, y0, x1, y1 = box
    crop = im.crop(box).convert('L')
    w, h = crop.size
    sw = 700
    sh = max(1, int(h * sw / w))
    s = np.asarray(crop.resize((sw, sh), Image.BILINEAR), dtype=np.float32)
    ink = np.clip(200 - s, 0, None)  # 越黑墨越多
    prof = ink[sh // 20 : -sh // 20].mean(axis=0)
    k = 9
    prof = np.convolve(prof, np.ones(k) / k, mode='same')
    lo, hi = int(sw * 0.30), int(sw * 0.70)
    seg = prof[lo:hi]
    if not len(seg):
        return None
    i = int(np.argmin(seg)) + lo
    base = float(np.median(prof))
    if base <= 0:
        return None
    # 栏间空白要明显比整体淡，且位于中间区域
    if seg.min() > base * 0.55:
        return None
    return x0 + (x1 - x0) * i / sw, base, float(seg.min())


def enhance(tile, scale):
    if scale and scale != 1:
        tile = tile.resize((int(tile.width * scale), int(tile.height * scale)), Image.LANCZOS)
    tile = ImageOps.autocontrast(tile, cutoff=1)
    tile = tile.filter(ImageFilter.UnsharpMask(radius=2.0, percent=130, threshold=3))
    return tile


def auto_scale(tile, target=TARGET_AREA, cap=2.6):
    area = tile.width * tile.height
    if area <= 0:
        return 1.0
    s = (target / area) ** 0.5
    return max(1.0, min(cap, s))


def slices(a, b, rows, overlap):
    """把 [a,b) 切成 rows 段，相邻段重叠 overlap 比例。"""
    total = b - a
    if rows <= 1:
        return [(a, b)]
    each = total / rows
    ov = each * overlap
    out = []
    for i in range(rows):
        s = a + i * each - (ov if i else 0)
        e = a + (i + 1) * each + (ov if i < rows - 1 else 0)
        out.append((int(max(a, s)), int(min(b, e))))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('outdir')
    ap.add_argument('--mode', default='col', choices=['page', 'col', 'strip', 'multi', 'cols', 'halves'])
    ap.add_argument('--rows', type=int, default=3)
    ap.add_argument('--overlap', type=float, default=0.12)
    ap.add_argument('--scale', type=float, default=0, help='0 = 自动放大到约 2.6MP')
    ap.add_argument('--no-enhance', action='store_true')
    args = ap.parse_args()

    im = load(args.src)
    box = paper_box(im)
    os.makedirs(os.path.join(args.outdir, 'tiles'), exist_ok=True)
    manifest = {'src': args.src, 'paperBox': box, 'mode': args.mode, 'tiles': []}

    if args.mode == 'page':
        regions = [('整页', box, 1, 1, 1)]
    elif args.mode == 'multi':
        g = gutter(im, box)
        if g:
            gx = int(g[0])
            regions = [('整页', box, 1, 1, 1)]
            regions.append(('左栏放大图', (box[0], box[1], gx, box[3]), 1, 1, 1))
            regions.append(('右栏放大图', (gx, box[1], box[2], box[3]), 2, 1, 1))
        else:
            ymid = (box[1] + box[3]) // 2
            regions = [
                ('整页', box, 1, 1, 1),
                ('上半页放大图', (box[0], box[1], box[2], ymid + 60), 1, 1, 1),
                ('下半页放大图', (box[0], ymid - 60, box[2], box[3]), 1, 2, 2),
            ]
    elif args.mode == 'cols':
        g = gutter(im, box)
        if not g:
            raise SystemExit('NO_GUTTER')
        gx = int(g[0])
        regions = [
            ('左栏（第 1 栏，共 2 栏）', (box[0], box[1], gx, box[3]), 1, 1, 1),
            ('右栏（第 2 栏，共 2 栏）', (gx, box[1], box[2], box[3]), 2, 1, 1),
        ]
    elif args.mode == 'halves':
        ymid = (box[1] + box[3]) // 2
        regions = [
            ('整页上半部分', (box[0], box[1], box[2], ymid + 80), 1, 1, 2),
            ('整页下半部分', (box[0], ymid - 80, box[2], box[3]), 1, 2, 2),
        ]
    elif args.mode == 'strip':
        regions = [
            (f'整页从上往下第 {i + 1}/{args.rows} 段', (box[0], s, box[2], e), 1, i + 1, args.rows)
            for i, (s, e) in enumerate(slices(box[1], box[3], args.rows, args.overlap))
        ]
    else:
        g = gutter(im, box)
        if not g:
            raise SystemExit('NO_GUTTER')
        gx = int(g[0])
        regions = []
        for ci, (x0, x1) in enumerate([(box[0], gx), (gx, box[2])]):
            for ri, (s, e) in enumerate(slices(box[1], box[3], args.rows, args.overlap)):
                regions.append(
                    (
                        f'第 {ci + 1} 栏（共 2 栏）从上往下第 {ri + 1}/{args.rows} 段',
                        (x0, s, x1, e),
                        ci + 1,
                        ri + 1,
                        args.rows,
                    )
                )

    for idx, (desc, bx, col, row, rows) in enumerate(regions, 1):
        tile = im.crop(bx)
        if not args.no_enhance:
            tile = enhance(tile, args.scale if args.scale else auto_scale(tile))
        name = f'{idx:02d}.jpg'
        tile.save(os.path.join(args.outdir, 'tiles', name), quality=92, optimize=True)
        manifest['tiles'].append(
            {'file': name, 'desc': desc, 'col': col, 'row': row, 'rows': rows, 'box': bx,
             'size': [tile.width, tile.height]}
        )

    with open(os.path.join(args.outdir, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(json.dumps({'tiles': len(regions), 'paperBox': box,
                      'sizes': [t['size'] for t in manifest['tiles']]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
