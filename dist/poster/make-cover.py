"""dsh-session-tools 商品封面（1:1，深色，Pillow 精绘）。

封面和"功能说明图"是两种东西：封面只要在缩略图尺寸下让人 3 秒内明白
「这是什么 + 解决什么痛 + 值不值得点」，细节留给详情页。

用法： python make-cover.py <输出目录>
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
S = 2

BG = (15, 17, 21)
INK = (243, 244, 247)
MUTED = (150, 156, 168)
FAINT = (104, 110, 124)
LINE = (42, 47, 58)
CARD = (23, 26, 33)
CARD2 = (27, 31, 39)
ACCENT = (91, 123, 255)
ACCENT_DIM = (36, 46, 84)
GREEN = (74, 197, 137)
GREEN_TINT = (19, 38, 30)

REG = "C:/Windows/Fonts/msyh.ttc"
BOLD = "C:/Windows/Fonts/msyhbd.ttc"


def font(size, bold=False):
    return ImageFont.truetype(BOLD if bold else REG, int(size * S))


def px(v):
    return int(round(v * S))


def box(x0, y0, x1, y1):
    return [px(x0), px(y0), px(x1), px(y1)]


def rrect(d, rect, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(rect, radius=px(r), fill=fill, outline=outline, width=max(1, px(width)))


def text(d, xy, s, f, fill=INK, anchor="la"):
    d.text((px(xy[0]), px(xy[1])), s, font=f, fill=fill, anchor=anchor)


def glow(canvas, cx, cy, rx, ry, color=ACCENT, alpha=70):
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.ellipse([px(cx - rx), px(cy - ry), px(cx + rx), px(cy + ry)], fill=color + (alpha,))
    layer = layer.filter(ImageFilter.GaussianBlur(px(90)))
    canvas.alpha_composite(layer)


def shadow(canvas, rect, r, blur=26, alpha=150, dy=16):
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    moved = [rect[0], rect[1] + px(dy), rect[2], rect[3] + px(dy)]
    d.rounded_rectangle(moved, radius=px(r), fill=(0, 0, 0, alpha))
    layer = layer.filter(ImageFilter.GaussianBlur(px(blur) / 2))
    canvas.alpha_composite(layer)


def check(d, x, y, size, on):
    rrect(d, box(x, y, x + size, y + size), 5,
          fill=GREEN if on else None,
          outline=None if on else (74, 80, 94), width=2)
    if on:
        d.line([(px(x + size * 0.25), px(y + size * 0.52)),
                (px(x + size * 0.44), px(y + size * 0.71)),
                (px(x + size * 0.77), px(y + size * 0.30))],
               fill=(11, 26, 20), width=px(2.6), joint="curve")


def logo_mark(d, x, y, size):
    rrect(d, box(x, y, x + size, y + size), size * 0.28, fill=ACCENT_DIM, outline=(72, 96, 190), width=1.5)
    rrect(d, box(x + size * 0.26, y + size * 0.20, x + size * 0.68, y + size * 0.80), 3,
          outline=(186, 200, 255), width=1.6)
    d.line([(px(x + size * 0.40), px(y + size * 0.52)), (px(x + size * 0.50), px(y + size * 0.62)),
            (px(x + size * 0.76), px(y + size * 0.34))], fill=GREEN, width=px(2.4), joint="curve")


def pills(d, items, x, y, h=46, gap=14, size=21):
    cx = x
    for label, tone in items:
        f = font(size, True)
        w = d.textlength(label, font=f) / S + 40
        rrect(d, box(cx, y, cx + w, y + h), h / 2,
              outline=ACCENT if tone == "accent" else LINE, width=1.4)
        text(d, (cx + 20, y + (h - size) / 2 - 2), label, f,
             ACCENT if tone == "accent" else (206, 211, 221))
        cx += w + gap


def pain_row(d, x, y, w, title, desc):
    d.ellipse(box(x, y + 8, x + 9, y + 17), fill=ACCENT)
    text(d, (x + 20, y), title, font(23, True), INK)
    text(d, (x + 20, y + 40), desc, font(17.5), MUTED)
    return w


def render(path, W, H):
    canvas = Image.new("RGBA", (W * S, H * S), BG + (255,))
    glow(canvas, W * 0.74, 430, 470, 300, ACCENT, 62)
    glow(canvas, W * 0.10, 1060, 380, 250, GREEN, 24)
    d = ImageDraw.Draw(canvas)

    pad = 96

    # ------------------------------------------------------------ 品牌行
    logo_mark(d, pad, 88, 58)
    text(d, (pad + 76, 92), "dsh-session-tools", font(27, True), INK)
    text(d, (pad + 76, 128), "DeepSeek Harness 的会话删除插件", font(20), (176, 183, 196))
    badge = "v0.5.5"
    fb = font(17, True)
    bw = d.textlength(badge, font=fb) / S + 34
    rrect(d, box(W - pad - bw, 96, W - pad, 134), 19, outline=LINE, width=1.4)
    text(d, (W - pad - bw / 2, 104), badge, fb, (196, 202, 214), anchor="ma")

    # ------------------------------------------------------------ 主张（一行说完）
    f_hook = font(100, True)
    part1 = "删得干净，"
    text(d, (pad, 186), part1, f_hook, INK)
    x2 = pad + d.textlength(part1, font=f_hook) / S
    text(d, (x2, 186), "留得明白", f_hook, GREEN)
    text(d, (pad + 2, 320), "DSH 里真正的会话删除：逐条挑产物、悬停先预览、删错七天可还原",
         font(25), (196, 202, 214))

    # ------------------------------------------------------------ 产品实景
    mx0, my0 = pad, 400
    mx1, my1 = 1150, 1062
    shadow(canvas, box(mx0, my0, mx1, my1), 26, blur=30, alpha=180, dy=18)
    d = ImageDraw.Draw(canvas)
    rrect(d, box(mx0, my0, mx1, my1), 26, fill=CARD, outline=(36, 41, 51), width=1.4)

    text(d, (mx0 + 36, my0 + 26), "删除会话", font(25, True), INK)
    text(d, (mx0 + 36, my0 + 62), "会话记录 · 投影缓存 · 它生成的文件", font(17), MUTED)
    text(d, (mx1 - 36, my0 + 32), "5 个 · 将删除 3 · 保留 2", font(17), (150, 156, 168), anchor="ra")

    rows = [
        ("reports/analysis.md", "340 KB", True, "交付物"),
        ("stamp/final.png", "2.1 MB", True, "图片"),
        ("assets/model.onnx", "1.9 MB", False, ""),
        ("out/deck.pdf", "812 KB", False, ""),
        ("notes/summary.docx", "96 KB", False, ""),
    ]
    ry = my0 + 118
    for i, (name, size, kept, tag) in enumerate(rows):
        top = ry + i * 62
        if kept:
            rrect(d, box(mx0 + 20, top - 11, mx1 - 20, top + 41), 10, fill=GREEN_TINT)
        check(d, mx0 + 38, top + 1, 21, kept)
        text(d, (mx0 + 72, top), name, font(18), INK if kept else (170, 176, 188))
        if tag:
            ft = font(13.5, True)
            tw = d.textlength(tag, font=ft) / S + 18
            rrect(d, box(mx1 - 250, top + 3, mx1 - 250 + tw, top + 27), 12, outline=(52, 92, 74), width=1.2)
            text(d, (mx1 - 250 + tw / 2, top + 6), tag, ft, (126, 205, 168), anchor="ma")
        text(d, (mx1 - 36, top + 2), size, font(16), FAINT, anchor="ra")

    # 处理方式（把"导出"和"回收站"也画进产品实景）
    oy = my1 - 214
    text(d, (mx0 + 38, oy + 6), "处理方式", font(15), MUTED)
    ox = mx0 + 148
    for label, tone in [("原地保留", ""), ("导出到桌面", ""), ("进回收站 · 7 天", "accent")]:
        fo = font(13.5, True)
        ow = d.textlength(label, font=fo) / S + 26
        rrect(d, box(ox, oy, ox + ow, oy + 32), 16,
              outline=(70, 92, 190) if tone == "accent" else (52, 58, 71), width=1.3)
        text(d, (ox + 13, oy + 6), label, fo, ACCENT if tone == "accent" else (186, 192, 204))
        ox += ow + 10

    text(d, (mx0 + 38, my1 - 140), "勾选 = 保留；不勾就跟着会话一起删", font(16), MUTED)

    by = my1 - 82
    bw2, bh2 = 112, 42
    rrect(d, box(mx1 - 36 - bw2, by, mx1 - 36, by + bh2), 10, fill=ACCENT)
    text(d, (mx1 - 36 - bw2 / 2, by + 11), "删除", font(17, True), (255, 255, 255), anchor="ma")
    rrect(d, box(mx1 - 36 - bw2 * 2 - 14, by, mx1 - 36 - bw2 - 14, by + bh2), 10,
          outline=(52, 58, 71), width=1.4)
    text(d, (mx1 - 36 - bw2 * 2 - 14 + bw2 / 2, by + 11), "取消", font(17), MUTED, anchor="ma")

    # ------------------------------------------------------------ 右侧预览卡（不压内容）
    qx0, qy0 = 1170, 452
    qx1, qy1 = W - pad, qy0 + 300
    shadow(canvas, box(qx0, qy0, qx1, qy1), 18, blur=26, alpha=190, dy=14)
    d = ImageDraw.Draw(canvas)
    rrect(d, box(qx0, qy0, qx1, qy1), 18, fill=CARD2, outline=(46, 52, 66), width=1.4)
    text(d, (qx0 + 18, qy0 + 14), "stamp/final.png", font(14), MUTED)
    rrect(d, box(qx0 + 18, qy0 + 42, qx1 - 18, qy1 - 44), 11, fill=(33, 39, 52))
    d.ellipse(box(qx0 + 36, qy0 + 62, qx0 + 64, qy0 + 90), fill=ACCENT)
    d.polygon([(px(qx0 + 20), px(qy1 - 52)), (px(qx0 + 86), px(qy0 + 118)), (px(qx1 - 40), px(qy1 - 52))],
              fill=(52, 62, 92))
    text(d, (qx0 + 18, qy1 - 34), "悬停即预览", font(13), (126, 134, 150))

    # ------------------------------------------------------------ 右栏：回收站小卡
    bx0, by0 = qx0, qy1 + 38
    bx1, by1 = qx1, by0 + 184
    rrect(d, box(bx0, by0, bx1, by1), 18, fill=(24, 27, 34), outline=(40, 46, 58), width=1.4)
    text(d, (bx0 + 18, by0 + 16), "回收站", font(17, True), INK)
    text(d, (bx0 + 18, by0 + 50), "删掉的先搬进去，", font(14), MUTED)
    text(d, (bx0 + 18, by0 + 74), "七天内一键还原", font(14), MUTED)
    text(d, (bx0 + 18, by0 + 138), "DSH_HOME/trash · 自动过期清理", font(11.5), FAINT)
    # 垃圾桶线稿
    tx, ty = bx1 - 92, by0 + 34
    d.line([(px(tx - 8), px(ty)), (px(tx + 58), px(ty))], fill=(120, 128, 146), width=px(2))
    d.line([(px(tx + 12), px(ty - 8)), (px(tx + 38), px(ty - 8))], fill=(120, 128, 146), width=px(2))
    rrect(d, box(tx + 2, ty + 8, tx + 48, ty + 62), 6, outline=(120, 128, 146), width=1.8)
    d.line([(px(tx + 16), px(ty + 20)), (px(tx + 16), px(ty + 50))], fill=(90, 98, 116), width=px(1.6))
    d.line([(px(tx + 34), px(ty + 20)), (px(tx + 34), px(ty + 50))], fill=(90, 98, 116), width=px(1.6))

    # ------------------------------------------------------------ 四个卖点
    pills(d, [("真删除", "accent"), ("逐条保留", ""), ("悬停预览", ""), ("回收站撤销", "")], pad, 1118)

    # ------------------------------------------------------------ 痛点 → 结果
    py = 1210
    col_w = (W - pad * 2) / 3
    # 这里说的是 DSH 原生的缺口，不是插件自己的历史 bug
    pain_row(d, pad, py, col_w, "只有归档", "会话藏起来，磁盘一点没省")
    pain_row(d, pad + col_w, py, col_w, "产物无主", "不知道哪些文件是它生成的")
    pain_row(d, pad + col_w * 2, py, col_w, "删除无门", "只能手动去 ~/.dsh 动目录")
    d.line([(px(pad + col_w - 40), px(py - 4)), (px(pad + col_w - 40), px(py + 62))], fill=(34, 38, 47), width=px(1.2))
    d.line([(px(pad + col_w * 2 - 40), px(py - 4)), (px(pad + col_w * 2 - 40), px(py + 62))],
           fill=(34, 38, 47), width=px(1.2))

    # ------------------------------------------------------------ 页脚
    d.line([(px(pad), px(H - 152)), (px(W - pad), px(H - 152))], fill=(34, 38, 47), width=px(1.2))
    text(d, (pad, H - 120), "单文件安装器 · 双击即装", font(21, True), INK)
    text(d, (pad + 306, H - 116), "零外部依赖 · 只动 DSH_HOME · 会话附件不碰", font(17), MUTED)
    text(d, (W - pad, H - 116), "Windows · DSH ≥ 0.2.0", font(17), FAINT, anchor="ra")

    canvas.convert("RGB").resize((W, H), Image.LANCZOS).save(path, "PNG")
    print("written", path, os.path.getsize(path), "bytes")


if __name__ == "__main__":
    render(os.path.join(OUT, "dsh-session-tools-cover-1600.png"), 1600, 1600)
