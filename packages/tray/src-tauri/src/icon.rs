//! The tray icon: a small watchtower with a status dot, drawn at run time so the icon needs no image files and follows the light or dark bar.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IconState {
    Up,
    Changed,
    Down,
    Unreachable,
}

pub const SIZE: u32 = 64;
const SUPER: u32 = 4;
// The drawing uses the 24-unit view box of the canvas the design was settled on.
const UNITS: f32 = 24.0;

fn ink(dark: bool) -> [u8; 3] {
    if dark { [0xe8, 0xe8, 0xea] } else { [0x1c, 0x1f, 0x24] }
}

fn dot(state: IconState, dark: bool) -> [u8; 3] {
    match (state, dark) {
        (IconState::Up, true) => [0x7f, 0xd6, 0xa0],
        (IconState::Up, false) => [0x1f, 0x9d, 0x5c],
        (IconState::Changed, true) => [0xf0, 0xb3, 0x5a],
        (IconState::Changed, false) => [0xb8, 0x72, 0x0c],
        (IconState::Down, true) => [0xe2, 0x77, 0x6b],
        (IconState::Down, false) => [0xc0, 0x46, 0x3a],
        (IconState::Unreachable, _) => [0x8f, 0xa6, 0xa3],
    }
}

fn dim(color: [u8; 3]) -> [u8; 3] {
    [color[0] / 2 + 0x30, color[1] / 2 + 0x30, color[2] / 2 + 0x30]
}

fn segment_distance(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    let (dx, dy) = (bx - ax, by - ay);
    let t = (((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
    ((px - ax - t * dx).powi(2) + (py - ay - t * dy).powi(2)).sqrt()
}

/// The warm colors of the tower: gold for the roof and gallery, amber for the lantern.
fn gold(dark: bool) -> [u8; 3] {
    if dark { [0xe8, 0xb8, 0x3a] } else { [0xa9, 0x74, 0x0c] }
}

fn lantern(dark: bool) -> [u8; 3] {
    if dark { [0xff, 0xb0, 0x2e] } else { [0xd9, 0x7a, 0x00] }
}

/// Which part of the tower, if any, covers a point. The tower stands left of center so the status dot can sit at the lower right.
fn tower_part(x: f32, y: f32) -> Option<Part> {
    // Roof: the triangle (10, 2), (14, 6), (6, 6).
    if (2.0..=6.0).contains(&y) && (x - 10.0).abs() <= (y - 2.0) {
        return Some(Part::Roof);
    }
    // Lantern room with two bars.
    if (6.0..10.0).contains(&y) && (7.2..=12.8).contains(&x) {
        return Some(if (x - 10.0).abs() < 0.5 { Part::Body } else { Part::Lantern });
    }
    // Gallery.
    if (10.0..=11.8).contains(&y) && (6.2..=13.8).contains(&x) {
        return Some(Part::Roof);
    }
    // Tower body, widening toward the base.
    if (11.8..=22.0).contains(&y) {
        let half = 2.3 + (y - 11.8) / (22.0 - 11.8) * 1.5;
        if (x - 10.0).abs() <= half {
            return Some(Part::Body);
        }
    }
    None
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Part {
    Roof,
    Lantern,
    Body,
}

fn sample(state: IconState, dark: bool, x: f32, y: f32) -> Option<[u8; 3]> {
    let unreachable = state == IconState::Unreachable;
    let (dot_x, dot_y) = (19.0, 19.0);
    let to_dot = ((x - dot_x).powi(2) + (y - dot_y).powi(2)).sqrt();
    if unreachable {
        let cross = segment_distance(x, y, 16.0, 16.0, 22.0, 22.0).min(segment_distance(x, y, 22.0, 16.0, 16.0, 22.0));
        if cross <= 1.0 {
            return Some(dot(state, dark));
        }
        if to_dot <= 6.5 {
            return None;
        }
    } else {
        if to_dot <= 4.5 {
            return Some(dot(state, dark));
        }
        // A gap around the dot keeps it readable on a small icon.
        if to_dot <= 6.0 {
            return None;
        }
    }
    let color = match tower_part(x, y)? {
        Part::Roof => gold(dark),
        Part::Lantern => lantern(dark),
        Part::Body => ink(dark),
    };
    Some(if unreachable { dim(color) } else { color })
}

/// Straight-alpha RGBA pixels, SIZE by SIZE.
pub fn render(state: IconState, dark: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    let scale = UNITS / (SIZE * SUPER) as f32;
    for py in 0..SIZE {
        for px in 0..SIZE {
            let (mut r, mut g, mut b, mut hits) = (0u32, 0u32, 0u32, 0u32);
            for sy in 0..SUPER {
                for sx in 0..SUPER {
                    let x = ((px * SUPER + sx) as f32 + 0.5) * scale;
                    let y = ((py * SUPER + sy) as f32 + 0.5) * scale;
                    if let Some(c) = sample(state, dark, x, y) {
                        r += c[0] as u32;
                        g += c[1] as u32;
                        b += c[2] as u32;
                        hits += 1;
                    }
                }
            }
            if hits == 0 {
                out.extend_from_slice(&[0, 0, 0, 0]);
            } else {
                let total = SUPER * SUPER;
                out.extend_from_slice(&[(r / hits) as u8, (g / hits) as u8, (b / hits) as u8, (hits * 255 / total) as u8]);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(buf: &[u8], x: f32, y: f32) -> [u8; 4] {
        let (px, py) = ((x / UNITS * SIZE as f32) as usize, (y / UNITS * SIZE as f32) as usize);
        let at = (py * SIZE as usize + px) * 4;
        [buf[at], buf[at + 1], buf[at + 2], buf[at + 3]]
    }

    #[test]
    fn the_status_dot_takes_the_state_color_and_a_gap_surrounds_it() {
        for (state, color) in [(IconState::Up, [0x7f, 0xd6, 0xa0]), (IconState::Changed, [0xf0, 0xb3, 0x5a]), (IconState::Down, [0xe2, 0x77, 0x6b])] {
            let buf = render(state, true);
            let p = pixel(&buf, 19.0, 19.0);
            assert_eq!(&p[..3], &color);
            assert_eq!(p[3], 255);
            // Between the tower and the dot, inside the dot's gap, nothing is drawn.
            assert_eq!(pixel(&buf, 13.2, 19.0)[3], 0);
        }
    }

    #[test]
    fn the_tower_is_gold_amber_and_ink_and_follows_the_bar_theme() {
        let dark = render(IconState::Up, true);
        let light = render(IconState::Up, false);
        assert_eq!(&pixel(&dark, 10.0, 4.5)[..3], &[0xe8, 0xb8, 0x3a]);
        assert_eq!(&pixel(&light, 10.0, 4.5)[..3], &[0xa9, 0x74, 0x0c]);
        assert_eq!(&pixel(&dark, 8.0, 8.0)[..3], &[0xff, 0xb0, 0x2e]);
        assert_eq!(&pixel(&dark, 10.0, 16.0)[..3], &[0xe8, 0xe8, 0xea]);
        assert_eq!(&pixel(&light, 10.0, 16.0)[..3], &[0x1c, 0x1f, 0x24]);
        assert_eq!(pixel(&dark, 1.0, 1.0)[3], 0);
    }

    #[test]
    fn an_unreachable_hub_shows_a_grey_cross_instead_of_a_dot() {
        let buf = render(IconState::Unreachable, true);
        assert_eq!(&pixel(&buf, 19.0, 19.0)[..3], &[0x8f, 0xa6, 0xa3]);
        // The dot's old footprint is empty apart from the cross strokes.
        assert_eq!(pixel(&buf, 19.0, 14.6)[3], 0);
        assert_ne!(render(IconState::Unreachable, true), render(IconState::Up, true));
    }

    /// Writes each state's pixels as raw RGBA next to the given path, for a look at the glyph. Runs only on request: `SCOUT_ICON_DUMP=dir cargo test -- --ignored dump`.
    #[test]
    #[ignore]
    fn dump_the_glyphs() {
        let dir = std::env::var("SCOUT_ICON_DUMP").unwrap();
        for (name, state) in [("up", IconState::Up), ("changed", IconState::Changed), ("down", IconState::Down), ("unreachable", IconState::Unreachable)] {
            for (theme, dark) in [("dark", true), ("light", false)] {
                std::fs::write(format!("{dir}/{name}-{theme}.rgba"), render(state, dark)).unwrap();
            }
        }
    }
}
