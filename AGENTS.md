# HiGhostty 給 AI 代理的注意事項

專案說明、建置與檢查指令見 `README.md`。

## 鍵盤輸入（`src-tauri/native/bridge.m` 的 `HGSurface`）

修改任何鍵盤／輸入法相關程式碼前，先讀 `docs/keyboard-input.md`。重點：

- 輸入法傳入的字串（`insertText:` 等）一定要 `copy` 後再保存，否則文字會在使用前被清空。
- AppKit 回呼不可讓 Objective-C exception 漏出，否則穿過 tao 的 Rust `sendEvent:` 會直接 abort；沿用 `@try/@catch` + `reportInputException:` 的包裝模式。
- 只有 KeyDown／KeyUp 事件可以讀 `characters` 系列屬性，`flagsChanged` 讀取會丟 exception。
- debug build 會啟用 `HG_DEBUG_INPUT` trace，行為與 release 不同；兩者都要實測。
- 改完照 `docs/keyboard-input.md` 的驗收清單實際操作，不能只靠程式碼審閱或 `npm test`（測試不涵蓋原生輸入）。

## 標題列拖曳（`src/main.ts` 的 `<header>`）

修改 header 結構、`data-tauri-drag-region`、header 內的滑鼠事件，或升級 Tauri 前，先讀 `docs/window-drag.md`。重點：

- 拖曳完全交給 Tauri 自動注入的 `drag.js`；不可在拖曳區另外綁 `mousedown` 呼叫 `startDragging()`，兩者疊加會偶發拖不動。
- header 用 `data-tauri-drag-region="deep"`；不帶值的屬性只對「直接點在該元素上」有效，點到子元素不會拖曳。
- header 內新增的自製按鈕要能被排除（原生 `<button>`，或加 `role="button"`／`data-tauri-drag-region="false"`）。
- 改完照 `docs/window-drag.md` 的驗收清單在實際 App 操作，`npm test` 不涵蓋。

## 檔案面板（`src/files-panel.ts`、`src/files.ts`、`src-tauri/native/files.m`）

修改檔案面板、檔案操作、Quick Look 或剪貼簿相關程式碼前，先讀 `docs/files-panel.md`。重點：

- 原生終端機 NSView 疊在 WebView 之上；面板必須是 `#terminals` 的兄弟元素、不可與終端機矩形重疊。右鍵選單一律用原生 `Menu.popup()`，不要做 HTML 浮動選單。
- 會改動檔案的操作（拷貝、搬移、改名、新增、垃圾桶）集中在 `files.m` 的 `hg_files`，同名改名規則只在這裡實作；它在背景執行緒執行，不可碰 AppKit UI。剪貼簿、Quick Look、打開方式等 AppKit 操作走 `hg_command` 的 `files-*` op（主執行緒）。
- 原生程式沿用 `@try/@catch`，不讓 Objective-C exception 漏出。
- 純狀態邏輯放 `src/files.ts` 並補 `tests/files.test.mjs`；`npm test` 不涵蓋原生操作，改完照 `docs/files-panel.md` 的驗收清單實機操作。

## 指令片段面板（`src/snippet-palette.ts`、`src/snippets.ts`、`src-tauri/src/snippets.rs`）

修改 ⌘⇧P 面板、片段儲存或 `bridge.m` 的 `overlay-cutout` 前，先讀 `docs/snippet-palette.md`。重點：

- 面板是 HTML，但終端機 NSView 在 WebView 之上；靠 `overlay-cutout`（`layer.mask` 挖洞＋`hitTest` 穿透）顯示，不可改成縮小終端機或做會被遮住的浮層。面板關閉時要送全零取消遮罩。
- ⌘⇧P 在原生 local monitor 攔截；面板內快捷鍵避開 Ghostty app 層綁定（例如 ⌘N）。輸入法選字中不處理 Enter／方向鍵。
- 匹配與排序邏輯只放 `src/snippets.ts` 並補 `tests/snippets.test.mjs`；改完照驗收清單實機操作。

## 待處理提示（`src/attention.ts`、`src-tauri/src/{attention,hooks}.rs`、`bridge.m` 的 `scan`）

修改響鈴／agent 等待偵測或 hook 安裝前，先讀 `docs/attention.md`。重點：

- 判定邏輯只放 `src/attention.ts` 並補 `tests/attention.test.mjs`；偵測看版面特徵，不要比對整句 agent 文案。
- hook 安裝只能增刪 command 含 `hg-notify` 的項目，不可改動使用者其他設定；改動檔案前要備份、解析失敗不寫入；邏輯補 `hooks.rs` 單元測試。
- 「待處理」面板在 drawer（HTML），不要做會被終端機 NSView 蓋住的浮層。

## tmux 背景執行（`src/tmux.ts`、`src/main.ts` 的 `freezeSession`／`restoreSession`、`src-tauri/src/main.rs` 的 session 命令）

修改頁籤 tmux 持久化前，先讀 `docs/tmux.md`。重點：

- 命令與 session 名稱邏輯只放 `src/tmux.ts` 並補 `tests/tmux.test.mjs`；session 名稱一律經 `validSession` 驗證（會進 shell）。
- 結束 app 不可 kill session（`keepTmux`），手動關閉才 kill；關閉流程要先 `freezeSession`，否則空狀態會覆寫 `session.json`。
- 改完照 `docs/tmux.md` 的驗收清單實機操作。
