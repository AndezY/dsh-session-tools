"""dsh-session-tools 宣传图（简约扁平风，Pillow 精绘）。

画布按 2x 渲染再降采样，保证中文边缘干净。
用法： python make-poster.py <输出目录>
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
S = 2  # 超采样倍率

BG = (247, 246, 243)
INK = (22, 24, 29)
MUTED = (108, 114, 128)
FAINT = (168, 173, 184)
LINE = (231, 229, 223)
CARD = (255, 255, 255)
ACCENT = (77, 107, 254)
ACCENT_SOFT = (232, 236, 255)
GREEN = (46, 158, 107)
GREEN_SOFT = (232, 246, 239)
AMBER = (201, 138, 46)
AMBER_SOFT = (250, 242, 226)

REG = "C:/Windows/Fonts/msyh.ttc"
BOLD = "C:/Windows/Fonts/msyhbd.ttc"


def font(size, bold=False):
    return ImageFont.truetype(BOLD if bold else REG, int(size * S))


def px(v):
    return int(round(v * S))


def box(x0, y0, x1, y1):
    return [px(x0), px(y0), px(x1), px(y1)]


def rrect(draw, rect, r, fill=None, outline=None, width=1):
    draw.rounded_rectangle(rect, radius=px(r), fill=fill, outline=outline, width=max(1, px(width)))


def text(draw, xy, s, f, fill=INK, anchor="la", spacing=None):
    draw.text((px(xy[0]), px(xy[1])), s, font=f, fill=fill, anchor=anchor, spacing=px(spacing or 0))


def shadow(canvas, rect, r, blur=18, alpha=38, dy=10):
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    moved = [rect[0], rect[1] + px(dy), rect[2], rect[3] + px(dy)]
    d.rounded_rectangle(moved, radius=px(r), fill=(20, 24, 40, alpha))
    layer = layer.filter(ImageFilter.GaussianBlur(px(blur) / 2))
    canvas.alpha_composite(layer) if canvas.mode == "RGBA" else canvas.paste(
        Image.alpha_composite(canvas.convert("RGBA"), layer).convert("RGB"), (0, 0)
    )


def check(draw, x, y, size, checked, accent=ACCENT):
    rrect(draw, box(x, y, x + size, y + size), 5,
          fill=accent if checked else None,
          outline=None if checked else (200, 204, 214), width=2)
    if checked:
        pts = [
            (px(x + size * 0.26), px(y + size * 0.53)),
            (px(x + size * 0.44), px(y + size * 0.71)),
            (px(x + size * 0.76), px(y + size * 0.32)),
        ]
        draw.line(pts, fill=(255, 255, 255), width=px(2.4), joint="curve")


def arrow(draw, x0, y, x1, color=FAINT):
    draw.line([(px(x0), px(y)), (px(x1), px(y))], fill=color, width=px(1.6))
    draw.line([(px(x1 - 6), px(y - 5)), (px(x1), px(y)), (px(x1 - 6), px(y + 5))],
              fill=color, width=px(1.6), joint="curve")


def render(path, W, H, title_size, cols, hero_h, rows_gap, feature_h, subtitle):
    canvas = Image.new("RGB", (W * S, H * S), BG)
    d = ImageDraw.Draw(canvas)

    pad = 80
    # ---------------------------------------------------------------- 头部
    pill_text = "DeepSeek Harness 插件 · v0.5.0"
    f_pill = font(17)
    tw = d.textlength(pill_text, font=f_pill) / S
    rrect(d, box(pad, 92, pad + tw + 36, 134), 21, fill=ACCENT_SOFT)
    text(d, (pad + 18, 103), pill_text, f_pill, ACCENT)

    text(d, (pad, 158), "会话删除", font(title_size, True), INK)
    text(d, (pad, 158 + title_size + 30), subtitle, font(26), MUTED)

    # ---------------------------------------------------------------- 主体：对话框还原
    hero_y = 158 + title_size + 30 + 52
    hero_x1 = W - pad - 330
    shadow(canvas, box(pad, hero_y, hero_x1, hero_y + hero_h), 22)
    d = ImageDraw.Draw(canvas)
    rrect(d, box(pad, hero_y, hero_x1, hero_y + hero_h), 22, fill=CARD, outline=LINE, width=1)

    text(d, (pad + 26, hero_y + 22), "删除会话", font(21, True), INK)
    text(d, (pad + 26, hero_y + 54), "整段会话记录 + 投影缓存 + 它生成的文件", font(15), MUTED)

    rows = [
        ("reports/analysis.md", "340 KB", True),
        ("assets/model.onnx", "1.9 MB", False),
        ("out/deck.pdf", "812 KB", False),
    ]
    ry = hero_y + 96
    for i, (name, size, kept) in enumerate(rows):
        top = ry + i * 62
        if kept:
            rrect(d, box(pad + 18, top - 8, hero_x1 - 18, top + 44), 9, fill=GREEN_SOFT)
        check(d, pad + 30, top + 6, 20, kept, GREEN if kept else ACCENT)
        text(d, (pad + 66, top), name, font(16), INK if kept else MUTED)
        text(d, (hero_x1 - 40, top + 1), size, font(14), FAINT, anchor="ra")

    # 一句说明，填住中间留白
    text(d, (pad + 30, hero_y + hero_h - 116), "勾选 = 保留；不勾就跟着会话一起删", font(13.5), MUTED)

    # 底部按钮
    by = hero_y + hero_h - 52
    bw2, bh2 = 92, 34
    rrect(d, box(hero_x1 - 34 - bw2, by, hero_x1 - 34, by + bh2), 9, fill=ACCENT)
    text(d, (hero_x1 - 34 - bw2 / 2, by + 8), "删除", font(14, True), (255, 255, 255), anchor="ma")
    rrect(d, box(hero_x1 - 34 - bw2 * 2 - 12, by, hero_x1 - 34 - bw2 - 12, by + bh2), 9, outline=LINE, width=1)
    text(d, (hero_x1 - 34 - bw2 * 2 - 12 + bw2 / 2, by + 8), "取消", font(14), MUTED, anchor="ma")

    # 浮动预览卡（叠在右边）
    px0, py0 = hero_x1 - 20, hero_y + 46
    px1, py1 = W - pad, py0 + 244
    shadow(canvas, box(px0, py0, px1, py1), 16, blur=22, alpha=44, dy=12)
    d = ImageDraw.Draw(canvas)
    rrect(d, box(px0, py0, px1, py1), 16, fill=CARD, outline=LINE, width=1)
    text(d, (px0 + 16, py0 + 12), "stamp/final.png", font(13), MUTED)
    thumb = box(px0 + 16, py0 + 40, px1 - 16, py1 - 44)
    rrect(d, thumb, 10, fill=(238, 241, 246))
    d.ellipse(box(px0 + 34, py0 + 58, px0 + 58, py0 + 82), fill=ACCENT)
    d.polygon([(px(px0 + 20), px(py1 - 56)), (px(px0 + 78), px(py0 + 108)), (px(px1 - 34), px(py1 - 56))],
              fill=(196, 208, 232))
    text(d, (px0 + 16, py1 - 34), "悬停预览 · 2.1 MB", font(12), FAINT)

    # ---------------------------------------------------------------- 功能网格
    features = [
        ("真删除", "记录 / 缓存 / 账目\n一起清掉", ACCENT),
        ("逐条保留", "产物全列出来\n勾哪个留哪个", GREEN),
        ("悬停预览", "图片 / 代码 / Markdown\n就地看得见", ACCENT),
        ("打开 · 定位", "默认程序打开\n资源管理器定位", MUTED),
        ("回收站撤销", "删掉先进回收站\n7 天内原路还原", AMBER),
        ("占用预检", "被程序占着的\n先提示再动手", AMBER),
        ("目录分组", "三态勾选\n整棵子树一次点", ACCENT),
        ("批量删除", "同目录多个会话\n一次清完", MUTED),
        ("导出替代", "复制到桌面\n再删原地", GREEN),
    ]

    grid_y = hero_y + hero_h + 88
    # 小标题
    text(d, (pad, grid_y - 46), "能力一览", font(15, True), MUTED)
    d.line([(px(pad + 74), px(grid_y - 34)), (px(W - pad), px(grid_y - 34))], fill=LINE, width=px(1))
    gap = 20
    cw = (W - pad * 2 - gap * (cols - 1)) / cols
    for i, (name, desc, color) in enumerate(features[: cols * 3]):
        col = i % cols
        row = i // cols
        x0 = pad + col * (cw + gap)
        y0 = grid_y + row * (feature_h + gap)
        rrect(d, box(x0, y0, x0 + cw, y0 + feature_h), 16, fill=CARD, outline=LINE, width=1)
        rrect(d, box(x0 + 2, y0 + 18, x0 + 5, y0 + feature_h - 18), 2, fill=color)
        text(d, (x0 + 26, y0 + 22), name, font(21, True), INK)
        d.multiline_text((px(x0 + 26), px(y0 + 62)), desc, font=font(14.5), fill=MUTED, spacing=px(7))

    # ---------------------------------------------------------------- 收尾一句
    close_y = grid_y + 3 * (feature_h + gap) + 34
    rrect(d, box(pad, close_y + 6, pad + 4, close_y + 34), 2, fill=ACCENT)
    text(d, (pad + 18, close_y), "删除前先看一眼，删错了还能捡回来。", font(25, True), INK)

    # ---------------------------------------------------------------- 页脚
    fy = H - 108
    d.line([(px(pad), px(fy - 26)), (px(W - pad), px(fy - 26))], fill=LINE, width=px(1))
    text(d, (pad, fy), "单文件安装器 · 双击即装", font(15, True), INK)
    text(d, (pad + 200, fy + 1), "零外部依赖 · 只动 DSH_HOME · 会话附件不碰", font(14), MUTED)
    text(d, (W - pad, fy + 1), "dsh-session-tools", font(14), FAINT, anchor="ra")

    canvas = canvas.resize((W, H), Image.LANCZOS)
    canvas.save(path, "PNG")
    print("written", path, os.path.getsize(path), "bytes")


if __name__ == "__main__":
    render(
        os.path.join(OUT, "dsh-session-tools-poster.png"),
        W=1200,
        H=1600,
        title_size=92,
        cols=3,
        hero_h=430,
        rows_gap=20,
        feature_h=150,
        subtitle="真删 · 能留 · 能撤 · 看得见",
    )
