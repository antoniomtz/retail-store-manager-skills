#!/usr/bin/env python3
"""Build the animated store-character overlay from the generated sprite sheets."""

from __future__ import annotations

import colorsys
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from PIL import Image, ImageDraw, ImageOps


ROOT = Path(__file__).resolve().parents[1]
CHARACTER_DIR = ROOT / "public" / "characters"
SHEET_A = CHARACTER_DIR / "avatar-motion-a-alpha-hard.png"
SHEET_B = CHARACTER_DIR / "avatar-motion-b-alpha-hard.png"
ACTION_SHEET = CHARACTER_DIR / "avatar-actions-alpha.png"
OUTPUT_GIF = ROOT / "public" / "store-characters-moving.gif"
OUTPUT_POSTER = ROOT / "public" / "store-characters-poster.png"

CANVAS_SIZE = (1137, 909)
FRAME_COUNT = 72
FRAME_DURATION_MS = 100


@dataclass(frozen=True)
class CharacterSpec:
    name: str
    quadrant: tuple[int, int]
    path: tuple[tuple[float, float], ...]
    phase: float
    crop_right: int | None = None
    color: tuple[int, int, int] | None = None


@dataclass(frozen=True)
class TaskCharacterSpec:
    name: str
    foot: tuple[float, float]
    target_height: int
    color: tuple[int, int, int]
    phase: float


CHARACTERS = (
    CharacterSpec(
        name="blue-cart",
        quadrant=(1, 0),
        # A loop around the produce approach with an intentional browse pause.
        path=(
            (455, 648), (480, 625), (510, 600), (538, 575), (570, 550),
            (570, 550), (570, 550),
            (560, 528), (540, 510), (512, 498), (488, 500), (470, 512),
            (458, 530), (452, 550), (456, 570), (470, 590), (490, 610),
            (512, 627), (490, 642), (470, 650), (455, 648),
        ),
        phase=0.29,
    ),
    CharacterSpec(
        name="teal-cart-loop",
        quadrant=(1, 0),
        # Browses the front-of-store displays, then loops back through the aisle.
        path=(
            (395, 495), (410, 480), (425, 472), (440, 475), (450, 488),
            (450, 488), (450, 488),
            (455, 505), (450, 522), (438, 535), (422, 542), (407, 535),
            (396, 520), (392, 505), (395, 495),
        ),
        phase=0.04,
        color=(0, 137, 123),
    ),
    CharacterSpec(
        name="amber-cart-loop",
        quadrant=(1, 0),
        # Takes a separate loop through the grocery aisle approach and pauses to browse.
        path=(
            (482, 680), (505, 662), (528, 643), (544, 622), (552, 600),
            (548, 580), (536, 565), (518, 556),
            (518, 556), (518, 556),
            (500, 558), (488, 570), (482, 590), (486, 610), (498, 630),
            (512, 648), (500, 665), (480, 680), (482, 680),
        ),
        phase=0.61,
        color=(230, 159, 0),
    ),
    CharacterSpec(
        name="orange-box",
        quadrant=(0, 1),
        # Freight stays inside receiving and pauses at pickup and drop points.
        path=(
            (70, 235), (90, 252), (115, 273), (145, 295), (175, 312),
            (175, 312), (175, 312),
            (145, 295), (115, 273), (90, 252), (70, 235), (70, 235),
        ),
        phase=0.56,
    ),
)


TASK_CHARACTERS = (
    TaskCharacterSpec(
        # Scans the staged totes on the online-order cart.
        "opd-cart-fulfillment",
        (686, 225),
        44,
        (0, 137, 123),
        0.18,
    ),
    TaskCharacterSpec(
        # Picks and verifies items at the online-order storage rack.
        "opd-shelf-fulfillment",
        (756, 218),
        43,
        (230, 159, 0),
        0.67,
    ),
    TaskCharacterSpec(
        "aisle-5-shelf-check",
        (548, 474),
        57,
        (88, 166, 47),
        0.12,
    ),
    TaskCharacterSpec(
        "pickup-shelf-check",
        (972, 390),
        54,
        (0, 137, 123),
        0.63,
    ),
)


def remove_magenta_chroma(sprite: Image.Image) -> Image.Image:
    """Remove residual key-colored pixels before crops and GIF quantization."""

    cleaned = sprite.copy()
    pixels = []
    for red, green, blue, alpha in cleaned.getdata():
        magenta_key = (
            alpha
            and red >= 105
            and blue >= 85
            and green <= min(red, blue) * 0.72
            and abs(red - blue) <= 125
        )
        pixels.append((red, green, blue, 0 if magenta_key else alpha))
    cleaned.putdata(pixels)
    return cleaned


def crop_sprite_pair(
    sheet_a: Image.Image,
    sheet_b: Image.Image,
    spec: CharacterSpec,
) -> tuple[Image.Image, Image.Image]:
    """Crop one quadrant using the union alpha bounds so both frames align."""

    cell_w = sheet_a.width // 2
    cell_h = sheet_a.height // 2
    column, row = spec.quadrant
    left = column * cell_w
    top = row * cell_h
    right = left + (spec.crop_right or cell_w)
    bottom = top + cell_h

    first = remove_magenta_chroma(sheet_a.crop((left, top, right, bottom)))
    second = remove_magenta_chroma(sheet_b.crop((left, top, right, bottom)))
    bbox_a = first.getchannel("A").getbbox()
    bbox_b = second.getchannel("A").getbbox()
    if bbox_a is None or bbox_b is None:
        raise RuntimeError(f"Missing sprite content for {spec.name}")

    padding = 8
    union = (
        max(0, min(bbox_a[0], bbox_b[0]) - padding),
        max(0, min(bbox_a[1], bbox_b[1]) - padding),
        min(first.width, max(bbox_a[2], bbox_b[2]) + padding),
        min(first.height, max(bbox_a[3], bbox_b[3]) + padding),
    )
    return first.crop(union), second.crop(union)


def crop_action_pair(action_sheet: Image.Image, row: int) -> tuple[Image.Image, Image.Image]:
    """Crop a semantic A/B pose row while keeping both foot anchors aligned."""

    cell_width = action_sheet.width // 2
    cell_height = action_sheet.height // 2
    first = remove_magenta_chroma(
        action_sheet.crop((0, row * cell_height, cell_width, (row + 1) * cell_height))
    )
    second = remove_magenta_chroma(
        action_sheet.crop((cell_width, row * cell_height, action_sheet.width, (row + 1) * cell_height))
    )
    bbox_a = first.getchannel("A").getbbox()
    bbox_b = second.getchannel("A").getbbox()
    if bbox_a is None or bbox_b is None:
        raise RuntimeError(f"Missing action content in row {row}")

    padding = 8
    crops = []
    for image, bbox in ((first, bbox_a), (second, bbox_b)):
        crops.append(
            image.crop(
                (
                    max(0, bbox[0] - padding),
                    max(0, bbox[1] - padding),
                    min(cell_width, bbox[2] + padding),
                    min(cell_height, bbox[3] + padding),
                )
            )
        )

    # Generated cells may place an otherwise matching pose a few pixels left or
    # right. Center each body independently and align the bottoms so the fixed
    # compositor foot point is identical across both animation frames.
    target_width = max(sprite.width for sprite in crops)
    target_height = max(sprite.height for sprite in crops)
    aligned = []
    for sprite in crops:
        canvas = Image.new("RGBA", (target_width, target_height), (0, 0, 0, 0))
        canvas.alpha_composite(
            sprite,
            ((target_width - sprite.width) // 2, target_height - sprite.height),
        )
        aligned.append(canvas)
    return aligned[0], aligned[1]


def point_on_path(
    points: Sequence[tuple[float, float]],
    progress: float,
) -> tuple[float, float, float]:
    """Return x, y, and horizontal direction on a closed piecewise-linear path."""

    segment_progress = (progress % 1.0) * len(points)
    segment = int(segment_progress) % len(points)
    local = segment_progress - math.floor(segment_progress)
    start = points[segment]
    end = points[(segment + 1) % len(points)]
    x = start[0] + (end[0] - start[0]) * local
    y = start[1] + (end[1] - start[1]) * local
    return x, y, end[0] - start[0]


def recolor_lime_outfit(
    sprite: Image.Image,
    target_color: tuple[int, int, int],
) -> Image.Image:
    """Recolor saturated lime fabric while preserving identity and shading."""

    target_hue, target_saturation, _ = colorsys.rgb_to_hsv(
        *(channel / 255 for channel in target_color)
    )
    recolored = sprite.copy()
    pixels = []
    for red, green, blue, alpha in recolored.getdata():
        hue, saturation, value = colorsys.rgb_to_hsv(
            red / 255,
            green / 255,
            blue / 255,
        )
        if alpha and 0.16 <= hue <= 0.30 and saturation >= 0.35 and value >= 0.12:
            new_red, new_green, new_blue = colorsys.hsv_to_rgb(
                target_hue,
                min(1, max(saturation * 0.85, target_saturation * 0.75)),
                value,
            )
            pixels.append(
                (
                    round(new_red * 255),
                    round(new_green * 255),
                    round(new_blue * 255),
                    alpha,
                )
            )
        else:
            pixels.append((red, green, blue, alpha))
    recolored.putdata(pixels)
    return recolored


def recolor_blue_outfit(
    sprite: Image.Image,
    target_color: tuple[int, int, int],
) -> Image.Image:
    """Recolor the blue jacket while retaining the cart and its neutral chrome."""

    target_hue, target_saturation, _ = colorsys.rgb_to_hsv(
        *(channel / 255 for channel in target_color)
    )
    recolored = sprite.copy()
    pixels = []
    for red, green, blue, alpha in recolored.getdata():
        hue, saturation, value = colorsys.rgb_to_hsv(
            red / 255,
            green / 255,
            blue / 255,
        )
        blue_jacket = alpha and 0.52 <= hue <= 0.69 and saturation >= 0.38 and value >= 0.12
        if blue_jacket:
            new_red, new_green, new_blue = colorsys.hsv_to_rgb(
                target_hue,
                min(1, max(saturation * 0.85, target_saturation * 0.75)),
                value,
            )
            pixels.append(
                (
                    round(new_red * 255),
                    round(new_green * 255),
                    round(new_blue * 255),
                    alpha,
                )
            )
        else:
            pixels.append((red, green, blue, alpha))
    recolored.putdata(pixels)
    return recolored


def scale_sprite(
    sprite: Image.Image,
    foot_y: float,
    flip: bool,
    target_height: int | None = None,
) -> Image.Image:
    if target_height is None:
        target_height = round(max(42, min(82, 28 + 0.065 * foot_y)))
    target_width = max(1, round(sprite.width * target_height / sprite.height))
    scaled = sprite.resize((target_width, target_height), Image.Resampling.NEAREST)
    return ImageOps.mirror(scaled) if flip else scaled


def build_frames(
    sprite_pairs: dict[str, tuple[Image.Image, Image.Image]],
    task_sprite_pairs: dict[str, tuple[Image.Image, Image.Image]],
) -> list[Image.Image]:
    frames: list[Image.Image] = []
    for frame_index in range(FRAME_COUNT):
        canvas = Image.new("RGBA", CANVAS_SIZE, (0, 0, 0, 0))
        draw = ImageDraw.Draw(canvas, "RGBA")
        progress = frame_index / FRAME_COUNT
        placements = []

        for spec in CHARACTERS:
            x, y, horizontal_direction = point_on_path(spec.path, progress + spec.phase)
            moving = abs(horizontal_direction) > 0.01
            motion_frame = (frame_index // 4) % 2 if moving else 0
            sprite = sprite_pairs[spec.name][motion_frame]
            sprite = scale_sprite(sprite, y, horizontal_direction < 0)
            placements.append((y, x, y, sprite))

        for spec in TASK_CHARACTERS:
            x, y = spec.foot
            idle_frame = ((frame_index + round(spec.phase * FRAME_COUNT)) // 11) % 2
            sprite = task_sprite_pairs[spec.name][idle_frame]
            sprite = scale_sprite(sprite, y, False, spec.target_height)
            placements.append((y, x, y, sprite))

        for _, x, foot_y, sprite in sorted(placements, key=lambda item: item[0]):
            shadow_width = max(10, min(round(sprite.width * 0.42), round(sprite.height * 0.38)))
            shadow_height = max(3, round(sprite.height * 0.055))
            draw.ellipse(
                (
                    round(x - shadow_width / 2),
                    round(foot_y - shadow_height / 2),
                    round(x + shadow_width / 2),
                    round(foot_y + shadow_height / 2),
                ),
                fill=(20, 23, 22, 112),
            )
            inner_width = max(7, round(shadow_width * 0.67))
            inner_height = max(2, round(shadow_height * 0.62))
            draw.ellipse(
                (
                    round(x - inner_width / 2),
                    round(foot_y - inner_height / 2),
                    round(x + inner_width / 2),
                    round(foot_y + inner_height / 2),
                ),
                fill=(8, 10, 10, 168),
            )
            left = round(x - sprite.width / 2)
            top = round(foot_y - sprite.height)
            canvas.alpha_composite(sprite, (left, top))

        frames.append(canvas)

    return frames


def make_palette(frames: Sequence[Image.Image]) -> Image.Image:
    # Blend translucent antialiasing and contact shadows against neutral black.
    # Using the magenta transparency key here produces a purple halo in the GIF.
    swatch = Image.new("RGB", (512, 512), (0, 0, 0))
    x = 0
    y = 0
    for frame in frames[:: max(1, len(frames) // 12)]:
        crop = frame.getbbox()
        if crop is None:
            continue
        sample = frame.crop(crop)
        sample.thumbnail((120, 120), Image.Resampling.NEAREST)
        swatch.paste(sample, (x, y), sample)
        x += 128
        if x + 120 > swatch.width:
            x = 0
            y += 128
    return swatch.quantize(colors=255, method=Image.Quantize.MEDIANCUT)


def quantize_frame(frame: Image.Image, palette: Image.Image) -> Image.Image:
    alpha = frame.getchannel("A")
    rgb = Image.new("RGB", frame.size, (0, 0, 0))
    rgb.paste(frame, mask=alpha)
    indexed = rgb.quantize(palette=palette, dither=Image.Dither.NONE)
    transparency_mask = alpha.point(lambda value: 255 if value < 96 else 0)
    indexed.paste(255, mask=transparency_mask)
    colors = indexed.getpalette()
    colors[255 * 3 : 255 * 3 + 3] = [255, 0, 255]
    indexed.putpalette(colors)
    indexed.info["transparency"] = 255
    indexed.info["disposal"] = 2
    return indexed


def main() -> None:
    sheet_a = Image.open(SHEET_A).convert("RGBA")
    sheet_b = Image.open(SHEET_B).convert("RGBA")
    if sheet_a.size != sheet_b.size:
        raise RuntimeError("Sprite sheets must have identical dimensions")
    action_sheet = Image.open(ACTION_SHEET).convert("RGBA")

    sprite_pairs: dict[str, tuple[Image.Image, Image.Image]] = {}
    for spec in CHARACTERS:
        pair = crop_sprite_pair(sheet_a, sheet_b, spec)
        if spec.color is not None:
            pair = tuple(recolor_blue_outfit(sprite, spec.color) for sprite in pair)
        sprite_pairs[spec.name] = pair
        for suffix, sprite in zip(("a", "b"), pair, strict=True):
            sprite.save(CHARACTER_DIR / f"{spec.name}-{suffix}.png")

    waiting_pair = crop_action_pair(action_sheet, row=0)
    shelf_check_pair = crop_action_pair(action_sheet, row=1)
    for name, pair in (("waiting-idle", waiting_pair), ("shelf-check", shelf_check_pair)):
        for suffix, sprite in zip(("a", "b"), pair, strict=True):
            sprite.save(CHARACTER_DIR / f"{name}-{suffix}.png")

    task_sprite_pairs = {
        spec.name: tuple(
            recolor_lime_outfit(sprite, spec.color)
            for sprite in shelf_check_pair
        )
        for spec in TASK_CHARACTERS
    }

    frames = build_frames(sprite_pairs, task_sprite_pairs)
    frames[0].save(OUTPUT_POSTER)
    palette = make_palette(frames)
    indexed_frames = [quantize_frame(frame, palette) for frame in frames]
    indexed_frames[0].save(
        OUTPUT_GIF,
        save_all=True,
        append_images=indexed_frames[1:],
        duration=FRAME_DURATION_MS,
        loop=0,
        disposal=2,
        transparency=255,
        optimize=False,
    )

    print(f"Wrote {OUTPUT_GIF.relative_to(ROOT)} ({FRAME_COUNT} frames)")
    print(f"Wrote {OUTPUT_POSTER.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
