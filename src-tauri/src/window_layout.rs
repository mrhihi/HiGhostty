//! 主視窗啟動位置／大小的純計算。座標是 AppKit points（原點在左下，全螢幕共用），見 docs/window-placement.md。
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}
impl Rect {
    fn max_x(&self) -> f64 {
        self.x + self.w
    }
    fn max_y(&self) -> f64 {
        self.y + self.h
    }
    pub fn from_json(value: &Value) -> Option<Rect> {
        let get = |k: &str| value.get(k)?.as_f64().filter(|n| n.is_finite());
        Some(Rect { x: get("x")?, y: get("y")?, w: get("w")?, h: get("h")? })
    }
}
#[derive(Clone, Debug)]
pub struct Screen {
    pub key: String,
    pub visible: Rect,
    pub mouse: bool,
}
pub fn parse_screens(value: &Value) -> Vec<Screen> {
    value
        .get("screens")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|s| {
                    Some(Screen {
                        key: s.get("key")?.as_str()?.to_owned(),
                        visible: Rect::from_json(s.get("visible")?)?,
                        mouse: s.get("mouse").and_then(Value::as_bool).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

const DEFAULT_SIZE: (f64, f64) = (1280.0, 820.0);
const MIN_SIZE: (f64, f64) = (720.0, 480.0);

fn valid_size(w: f64, h: f64) -> bool {
    w.is_finite() && h.is_finite() && w >= MIN_SIZE.0 && h >= MIN_SIZE.1
}
fn size_of(entry: &Value, w_key: &str, h_key: &str) -> Option<(f64, f64)> {
    let (w, h) = (entry.get(w_key)?.as_f64()?, entry.get(h_key)?.as_f64()?);
    valid_size(w, h).then_some((w, h))
}

/// 大小不超過可視範圍（螢幕比最小值小時以螢幕為準），原點夾進可視範圍。
pub fn clamp_to(frame: Rect, visible: Rect) -> Rect {
    let w = frame.w.max(MIN_SIZE.0).min(visible.w);
    let h = frame.h.max(MIN_SIZE.1).min(visible.h);
    let x = frame.x.min(visible.max_x() - w).max(visible.x);
    let y = frame.y.min(visible.max_y() - h).max(visible.y);
    Rect { x, y, w, h }
}
fn centered(size: (f64, f64), visible: Rect) -> Rect {
    clamp_to(
        Rect { x: visible.x + (visible.w - size.0) / 2.0, y: visible.y + (visible.h - size.1) / 2.0, w: size.0, h: size.1 },
        visible,
    )
}

/// 存的是相對該螢幕可視範圍的位置（左邊距、上邊距），螢幕排列改變或 Dock 高度不同都不影響。
fn saved_frame(state: &Value, screen: &Screen) -> Option<Rect> {
    let entry = state.get("screens")?.get(&screen.key)?;
    let (w, h) = size_of(entry, "width", "height")?;
    let (left, top) = (entry.get("left")?.as_f64()?, entry.get("top")?.as_f64()?);
    (left.is_finite() && top.is_finite()).then_some(Rect {
        x: screen.visible.x + left,
        y: screen.visible.max_y() - top - h,
        w,
        h,
    })
}
fn target_screen<'a>(screens: &'a [Screen], preferred: Option<&str>) -> Option<&'a Screen> {
    preferred
        .and_then(|key| screens.iter().find(|s| s.key == key))
        .or_else(|| screens.iter().find(|s| s.mouse))
        .or_else(|| screens.first())
}

/// 啟動時主視窗要用的外框。`remember` 沿用上次所在螢幕與位置，否則在滑鼠所在螢幕置中；大小都取該螢幕自己的紀錄。
pub fn startup_frame(state: &Value, screens: &[Screen], remember: bool) -> Option<Rect> {
    let last = state.get("last_screen").and_then(Value::as_str).filter(|_| remember);
    let screen = target_screen(screens, last)?;
    if remember {
        if let Some(frame) = saved_frame(state, screen) {
            return Some(clamp_to(frame, screen.visible));
        }
    }
    let size = state
        .get("screens")
        .and_then(|all| all.get(&screen.key))
        .and_then(|entry| size_of(entry, "width", "height"))
        .unwrap_or(DEFAULT_SIZE);
    Some(centered(size, screen.visible))
}

/// 把視窗目前的外框記到它所在螢幕名下。
pub fn record(state: &mut Value, frame: Rect, screen_key: &str, visible: Rect) {
    if !valid_size(frame.w, frame.h) {
        return;
    }
    let entry = json!({
        "left": frame.x - visible.x,
        "top": visible.max_y() - frame.max_y(),
        "width": frame.w,
        "height": frame.h,
    });
    let Some(map) = state.as_object_mut() else { return };
    let screens = map.entry("screens").or_insert_with(|| json!({}));
    if let Some(screens) = screens.as_object_mut() {
        screens.insert(screen_key.to_owned(), entry);
    }
    map.insert("last_screen".into(), json!(screen_key));
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, w, h }
    }
    fn screen(key: &str, visible: Rect, mouse: bool) -> Screen {
        Screen { key: key.into(), visible, mouse }
    }
    /// 筆電 Retina（1512x944，扣選單列）＋上方、偏左的外接 2560x1440。
    fn two_screens(mouse_on_external: bool) -> Vec<Screen> {
        vec![
            screen("laptop", rect(0.0, 0.0, 1512.0, 920.0), !mouse_on_external),
            screen("external", rect(-400.0, 944.0, 2560.0, 1415.0), mouse_on_external),
        ]
    }
    #[test]
    fn center_uses_mouse_screen_visible_frame() {
        let frame = startup_frame(&json!({}), &two_screens(true), false).unwrap();
        assert_eq!(frame, rect(-400.0 + (2560.0 - 1280.0) / 2.0, 944.0 + (1415.0 - 820.0) / 2.0, 1280.0, 820.0));
    }
    #[test]
    fn center_uses_size_saved_for_that_screen() {
        let mut state = json!({});
        record(&mut state, rect(0.0, 944.0, 2000.0, 1200.0), "external", rect(-400.0, 944.0, 2560.0, 1415.0));
        let on_external = startup_frame(&state, &two_screens(true), false).unwrap();
        assert_eq!((on_external.w, on_external.h), (2000.0, 1200.0));
        let on_laptop = startup_frame(&state, &two_screens(false), false).unwrap();
        assert_eq!((on_laptop.w, on_laptop.h), (1280.0, 820.0));
    }
    #[test]
    fn remember_restores_exact_frame_on_last_screen() {
        let mut state = json!({});
        let frame = rect(100.0, 1000.0, 1500.0, 900.0);
        record(&mut state, frame, "external", rect(-400.0, 944.0, 2560.0, 1415.0));
        // 滑鼠在筆電上也要回到外接。
        assert_eq!(startup_frame(&state, &two_screens(false), true).unwrap(), frame);
    }
    #[test]
    fn remember_survives_screen_arrangement_change() {
        let mut state = json!({});
        record(&mut state, rect(100.0, 1000.0, 1500.0, 900.0), "external", rect(-400.0, 944.0, 2560.0, 1415.0));
        let moved = vec![screen("external", rect(1512.0, 0.0, 2560.0, 1415.0), false)];
        assert_eq!(startup_frame(&state, &moved, true).unwrap(), rect(2012.0, 56.0, 1500.0, 900.0));
    }
    #[test]
    fn remember_falls_back_to_mouse_screen_when_last_unplugged() {
        let mut state = json!({});
        record(&mut state, rect(100.0, 1000.0, 1500.0, 900.0), "external", rect(-400.0, 944.0, 2560.0, 1415.0));
        let laptop_only = vec![screen("laptop", rect(0.0, 0.0, 1512.0, 920.0), true)];
        let frame = startup_frame(&state, &laptop_only, true).unwrap();
        assert_eq!(frame, rect((1512.0 - 1280.0) / 2.0, (920.0 - 820.0) / 2.0, 1280.0, 820.0));
    }
    #[test]
    fn oversized_record_is_clamped_to_screen() {
        let mut state = json!({});
        record(&mut state, rect(0.0, 0.0, 2400.0, 1300.0), "laptop", rect(0.0, 0.0, 2560.0, 1415.0));
        let small = vec![screen("laptop", rect(0.0, 0.0, 1512.0, 920.0), true)];
        assert_eq!(startup_frame(&state, &small, true).unwrap(), rect(0.0, 0.0, 1512.0, 920.0));
    }
    #[test]
    fn record_rejects_bogus_size_and_no_screens_gives_none() {
        let mut state = json!({});
        record(&mut state, rect(0.0, 0.0, 10.0, 10.0), "laptop", rect(0.0, 0.0, 1512.0, 920.0));
        assert!(state.get("screens").is_none());
        assert!(startup_frame(&state, &[], false).is_none());
    }
}
