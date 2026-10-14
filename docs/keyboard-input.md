# 鍵盤輸入交接（修改前必讀）

鍵盤輸入全部在 `src-tauri/native/bridge.m` 的 `HGSurface`（`NSView <NSTextInputClient>`）。這段程式已經壞過兩次：一次是字元打不出來，一次是按修飾鍵讓整個 App abort。修改 `HGSurface` 的任何輸入方法、`inputTrace`、`keyEvent()`、`sendKey`，或調整 `build.rs` 的編譯旗標前，請先讀完本文件。

## 輸入流程

```
NSApp sendEvent → tao TaoWindow sendEvent:（Rust extern "C"）→ NSWindow
  ├─ performKeyEquivalent: → handleKeyEquivalent:   ⌘／⌃ 組合、Ghostty binding
  ├─ keyDown: → handleKeyDown:
  │     activeKeyTexts = []                         開始累積本次按鍵的文字
  │     interpretKeyEvents:                          交給輸入法
  │        ├─ insertText:  → handleInsertText:      確定的文字 → 加入 activeKeyTexts
  │        ├─ setMarkedText: → handleMarkedText:    組字中（preedit）
  │        └─ doCommandBySelector: → handleCommand: 方向鍵、Enter 等
  │     texts 有內容 → 每段文字各呼叫一次 sendKey(text)
  │     texts 為空   → sendKey(ghosttyCharacters(event))
  ├─ keyUp:        → sendKey(RELEASE)
  └─ flagsChanged: → handleFlagsChanged:            修飾鍵按下／放開
```

另有兩個路徑會先看到按鍵：`initialize()` 裡的 `NSEvent` local monitor（app 層快捷鍵、⌘O、⌘0）與 `globalKey` event tap（全域快捷鍵）。

## 不可違反的規則

1. **輸入法給的字串一定要 `copy`。**
   - `insertText:` 收到的可能是 `NSMutableAttributedString`；`-[NSAttributedString string]` 回傳的是即時 backing store，不是副本。
   - 輸入法會在 `insertText:` 回傳後清空並重用同一個物件。只存參照的話，`handleKeyDown` 讀到時已變成 `""`。
   - 症狀：只有方向鍵、Enter、Backspace 有效，一般字元時好時壞或完全打不出來。
   - 存到 `activeKeyTexts`、property 或之後才使用的任何輸入法字串，都要先 `copy`。`setMarkedText` 用 `initWithAttributedString:` 建新物件，已是副本。

2. **不可讓 Objective-C exception 離開任何 AppKit 回呼。**
   - 事件經過 tao 以 Rust `extern "C"` 實作的 `sendEvent:`。exception 穿過這個 frame 會觸發 `panic_cannot_unwind`，App 直接 abort，沒有任何錯誤畫面。
   - 每個 responder／`NSTextInputClient` 進入點都是「外層 `@try/@catch` 呼叫 `reportInputException:`，實作放在 `handle…` 方法」。新增進入點（例如 `mouseDown:`、`scrollWheel:` 若加入會丟例外的呼叫，或新的 `NSTextInputClient` 方法）也要沿用。
   - `performKeyEquivalent:` 在 catch 時回傳 `NO`。

3. **只有 `NSEventTypeKeyDown`／`KeyUp` 可以讀 `characters`、`charactersIgnoringModifiers`、`charactersByApplyingModifiers:`。**
   - 對 `flagsChanged` 等事件讀取會丟 `NSInternalInconsistencyException`。
   - `keyEvent()` 與 `inputTrace()` 都已依事件類型判斷；新增的記錄或轉換程式碼也要先檢查 `event.type`。

4. **debug 與 release 是不同程式碼。**
   - `build.rs` 在 debug profile 定義 `HG_DEBUG_INPUT`，開啟 `inputTrace`。上次 abort 只發生在 debug（`npm run tauri -- dev`），因為只有 trace 會對修飾鍵讀 `characters`。
   - 修改 trace 程式碼時要用 debug build 實測修飾鍵。

5. **`activeKeyTexts` 累積流程不要拆掉。**
   - 一次 `interpretKeyEvents:` 可能產生多段 `insertText:`（例如中文輸入法送出整句），每段都要作為該按鍵的 text 交給 `ghostty_surface_key`，Ghostty 才能正確處理 key encoding。
   - `activeKeyTexts` 為 `nil` 時（非按鍵觸發，例如輸入法選字視窗點選），才直接呼叫 `ghostty_surface_text`。

## 事故紀錄：2026-10-13

- 症狀：`tauri dev` 下只能輸入方向鍵／Enter／Backspace；打一陣子 App 消失。
- 證據：
  - `/private/tmp/highostty-keyboard.log` 中字母出現 `insert-text-accumulated sentChars=1`，接著卻是 `interpret sentChars=0`。
  - 整份 log 沒有任何修飾鍵（keyCode 54–63）紀錄，因為 trace 在寫入前就丟出 exception。
  - `~/Library/Logs/DiagnosticReports/highostty-*.ips` 主執行緒為 `tao::…::window::send_event` → `panic_cannot_unwind` → `abort`。
- 修正：規則 1、2、3。
- 注意：`docs/verification.md` 先前已記錄「不再因 modifier event 中止」，之後仍再次發生。輸入相關修改不能只靠程式碼審閱，必須照下方清單實測。

## 除錯方法

- **按鍵 trace**：debug build 會寫入 `/private/tmp/highostty-keyboard.log`（也會出現在 Console 的 `[HiGhostty keyboard]`）。測試前先清空檔案。
  - `key-down` → `insert-text-accumulated` → `interpret` → `surface-key` 為一次正常按鍵。
  - 字母的 `interpret` 與第一個 `surface-key` 應為 `sentChars=1`；若變成 0，代表文字在累積後遺失。
  - 第二個 `surface-key`（`result=0`）通常是 keyUp。
- **閃退**：查 `~/Library/Logs/DiagnosticReports/highostty-*.ips`。頂端若有 `panic_cannot_unwind` 與 tao `send_event`，幾乎都是 Objective-C exception 漏出 AppKit 回呼（規則 2）。
- 被 `@catch` 攔下的 exception 會以 warning 事件顯示「鍵盤輸入失敗：<name> <reason>」，看到時應找出來源，不要只靠 catch 吞掉。

## 修改輸入程式碼後的驗收清單

在 debug build（`CARGO_TARGET_DIR=/private/tmp/highostty-target npm run tauri -- dev`）逐項確認：

- [ ] 英文（ABC）輸入 `echo hello`，Enter 執行正常。
- [ ] Shift 打大寫、符號；單獨按放 Shift／Ctrl／Option／Cmd 不會閃退。
- [ ] 中文輸入法（注音、拼音等）組字時顯示 preedit，選字送出後正確。
- [ ] 切換輸入法（⌃Space 或 Caps Lock）後繼續輸入正常。
- [ ] ⌃C、⌃D、⌘C／⌘V、⌘T、⌘⇧T、⌘D 正常（含焦點在分割／分組收藏終端機時 ⌘T）。
- [ ] 方向鍵、Backspace、Tab、Esc 正常。
- [ ] log 中字母 `interpret` 為 `sentChars=1`，且有修飾鍵紀錄。
- [ ] `~/Library/Logs/DiagnosticReports` 沒有新增 `highostty-*.ips`。

再用 release build（`CARGO_TARGET_DIR=/private/tmp/highostty-target npm run tauri -- build`）抽測英文、中文輸入與修飾鍵，確認行為一致。
