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
- 原生右鍵選單一律走 `src/context-menu.ts` 的 `popupMenu`；選單開著時送 `Menu.new`／`close` 會讓整個 App 死結。
- 純狀態邏輯放 `src/files.ts` 並補 `tests/files.test.mjs`；`npm test` 不涵蓋原生操作，改完照 `docs/files-panel.md` 的驗收清單實機操作。

## 指令片段面板（`src/snippet-palette.ts`、`src/snippets.ts`、`src-tauri/src/snippets.rs`）

修改 ⌘⇧P 面板、片段儲存或 `bridge.m` 的 `overlay-cutout` 前，先讀 `docs/snippet-palette.md`。重點：

- 面板是 HTML，但終端機 NSView 在 WebView 之上；靠 `overlay-cutout`（`layer.mask` 挖洞＋`hitTest` 穿透）顯示，不可改成縮小終端機或做會被遮住的浮層。面板關閉時要送全零取消遮罩。
- ⌘⇧P 在原生 local monitor 攔截；面板內快捷鍵避開 Ghostty app 層綁定（例如 ⌘N）。輸入法選字中不處理 Enter／方向鍵。
- 匹配與排序邏輯只放 `src/snippets.ts` 並補 `tests/snippets.test.mjs`；改完照驗收清單實機操作。

## 待處理提示（`src/attention.ts`、`src/prompt-rules.{ts,json}`、`bridge.m` 的 `scan`）

修改響鈴／agent 等待偵測或辨識規則前，先讀 `docs/attention.md`。重點：

- 判定邏輯只放 `src/attention.ts`，規則載入與合併只放 `src/prompt-rules.ts`，並補 `tests/attention.test.mjs`、`tests/prompt-rules.test.mjs`。沒有 hook 機制，只靠響鈴／通知／標題 spinner 與畫面辨識。
- 比對用的字串（關鍵字、頁尾、agent 行程名）放在規則檔 `src/prompt-rules.json`（使用者可用資料目錄的 `prompt-rules.json` 覆蓋），不要寫死在程式裡；規則檔必須維持可通過 `buildRules`，新增規則要補測試案例。
- 使用者規則檔有誤時整份退回內建規則並顯示原因，不可讓偵測失效。
- 「待處理」是頂部浮層（`src/attention-drop.ts`，HTML），靠 `overlay-cutout` 顯示，細節見 `docs/attention.md`；不要做會被終端機 NSView 蓋住的浮層。

## tmux 背景執行（`src/tmux.ts`、`src/main.ts` 的 `freezeSession`／`restoreSession`、`src-tauri/src/main.rs` 的 session 命令）

修改頁籤 tmux 持久化前，先讀 `docs/tmux.md`。重點：

- 命令與 session 名稱邏輯只放 `src/tmux.ts` 並補 `tests/tmux.test.mjs`；session 名稱一律經 `validSession` 驗證（會進 shell）。
- 結束 app 不可 kill session（`keepTmux`），手動關閉才 kill；關閉流程要先 `freezeSession`，否則空狀態會覆寫 `session.json`。
- 改完照 `docs/tmux.md` 的驗收清單實機操作。

## agent 控制指令（`src/control.ts`、`src-tauri/src/control.rs`、`highostty ctl`）

修改 socket、`ctl` CLI、`HIGHOSTTY_*` 環境變數注入或 `control-request` 轉送前，先讀 `docs/agent-control.md`。重點：

- 指令名稱、參數解析、權限（`write` 指令只在「完整」模式可用）、回覆格式等純邏輯只放 `src/control.ts` 的 `OPS` 表並補 `tests/control.test.mjs`；Rust 與 CLI 不解析指令。
- 新增會改動狀態或送輸入的指令一定要標 `write: true`；預設模式是唯讀。
- 每個視窗都要回覆 `control-request`（claim 為 owner／part／none），Rust 靠數量判斷是否全部回覆；改 `handleControl` 時不可讓任何路徑漏回覆，否則其他視窗的請求會拖到逾時。
- socket 只接受同一使用者（0600＋`getpeereid`），不放 token（會出現在 tmux 命令列）；不可放寬。
- 環境變數經 `native` 的 `open` 注入（`bridge.m` 的 `env_vars`）；tmux 頁籤走 `tmuxCommand` 的 `-e`（tmux 3.2+）。改 `tmuxCommand` 時同步讀 `docs/tmux.md`。
- 原生程式沿用 `@try/@catch`；新增 `key` 之類的輸入 op 前先讀 `docs/keyboard-input.md`。
- 改完照 `docs/agent-control.md` 的驗收清單實機操作（`npm test` 與 `cargo test` 不涵蓋 socket 與原生環境變數）。

## 檔案預覽窗（`src/preview.ts`、`src/preview-panel.ts`、`src-tauri/src/preview.rs`、`ctl preview`）

修改預覽窗、`updateLayout()` 的版面切分或 `ctl preview` 前，先讀 `docs/preview.md`。重點：

- 預覽窗靠 `updateLayout()` 把 `#terminals` 切成「終端機區＋預覽區」，原生終端機只佔終端機區；不用 cutout、不放進分割樹。不可對 `#terminals` 呼叫 `replaceChildren`（會清掉預覽窗），只移除 `.surface-outline`。
- 幾何與狀態邏輯只放 `src/preview.ts` 並補 `tests/preview.test.mjs`。自動更新是對路徑輪詢 `preview_stat`，不要改成對檔案 watch（rename 存檔會失效）。
- Markdown 一定要經 `DOMPurify.sanitize`；連結只處理 http(s) 與 `.md`，其餘忽略。
- `tab.preview` 只存在記憶體，不寫進 session／收藏；`ctl preview *` 維持 `write: false`，並保持不搶焦點。
- 改完照 `docs/preview.md` 的驗收清單實機操作。

## 多國語系（`src/i18n.ts`、`src/i18n-runtime.ts`、`src/locales/`、`src-tauri/src/locales.rs`）

新增或修改任何使用者看得到的字串、語系檔格式、設定頁「語言」或 `bridge.m` 的 `native.*` 字串前，先讀 `docs/i18n.md`。重點：

- UI 字串一律走 `t()`（動態）或 `data-i18n*` 屬性（靜態 HTML），並同步補 `src/locales/en/*.json` 與 `zh-Hant/*.json`（key 與 `{參數}` 必須一致）；不要在模組載入時快取翻譯結果。
- `src/i18n.ts` 保持 DOM-free，且不 import Vite／Tauri 專屬模組；被 node 測試載入的模組要寫 `from "./i18n.ts"`（含副檔名）。純邏輯模組的驗證錯誤回傳結構化資料，顯示時才翻譯。
- 原生字串走 `bridge.m` 的 `L(key, fallback)`，key 以 `native.` 開頭並放在 locales 裡，fallback 用英文。
- 不翻譯：Rust 錯誤、`highostty ctl` 回覆（給 agent 看）、程式碼註解。
- 語系檔代碼會成為檔名；前端 `validLocaleCode` 與 Rust `valid_code` 規則必須一致，不可放寬。
- 改完照 `docs/i18n.md` 的驗收清單實機操作（`npm test` 不涵蓋原生字串與跨視窗切換）。
