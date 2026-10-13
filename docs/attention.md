# 待處理提示（響鈴／agent 等待輸入）

背景頁籤的終端機需要你時，頁籤列會標色、標題列鈴鐺顯示數字，「待處理」面板可不切頁籤直接看內容。

## 偵測分層（`src/attention.ts` 合併，越上層越可靠）
1. **hook**（`src-tauri/src/attention.rs`、`hooks.rs`）：agent 的 hook 呼叫 `hg-notify`，經 `$HIGHOSTTY_SOCKET`（Unix socket，0600）送到 App；每個終端機的環境變數 `HIGHOSTTY_SURFACE_ID` 由 `bridge.m` 的 `open` 以 `env_vars` 注入。事件 `waiting`／`done`／`resume`，`resume` 會清除提示。
2. **signal**：`bridge.m` 的 `RING_BELL`、`DESKTOP_NOTIFICATION` 會 emit `bell`／`notify`；標題 spinner（點字元）消失視為 agent 停下。
3. **idle**：`scan` op 讀 VIEWPORT 文字並判斷子行程是否為 agent；畫面變動過、靜止 3 秒、且呈現互動選單版型（`❯ 1.` 加編號選項或 `(y/n)`）才標「可能在等待」。只看版面、不比對整句文案。

**畫面快照**：每次提示產生時（hook／signal／idle），前端立刻用 `scan` 擷取該終端機 VIEWPORT 末 15 行存進 alert（`screen`，`attachScreen`），「待處理」卡片顯示「通知訊息＋當時的畫面」；之後畫面變動也不會被覆蓋。

使用中且視窗聚焦的頁籤不產生提示；切到頁籤或視窗取得焦點會清除。

## Hook 安裝／移除（設定面板）
- Claude Code：`~/.claude/settings.json`（Notification／Stop／UserPromptSubmit）。
- Codex：`~/.codex/config.toml` 頂端的 `# >>> highostty >>>` 區塊（`notify`）；已有自己的 `notify` 時拒絕安裝。
- Gemini CLI（實驗）：`~/.gemini/settings.json`，事件名稱尚未實測。
- 只增刪 command 含 `hg-notify` 的項目；首次修改備份為 `<檔>.highostty.bak`；設定檔無法解析時不寫入。

## 驗收清單
- 背景頁籤 `sleep 3; printf '\a'` → 頁籤列標色＋鈴鐺 +1；切到該頁籤後消失。
- `printf '\e]9;hi\a'` 出現通知項目。
- 安裝 Claude hook 後，權限／計畫核准詢問顯示 message；回答後清除。移除後 `settings.json` 與安裝前一致。
- 背景頁籤的 agent 跳出詢問後，鈴鐺面板卡片顯示當時畫面文字；agent 繼續執行、畫面改變後該卡片內容不變。
- 未裝 hook 時，agent 停在選單數秒後出現「等待？」。
- 執行中不誤報；20+ 頁籤不卡；標題列拖曳正常（`docs/window-drag.md`）。
- debug 與 release 都要試。

## 待處理浮層（`src/attention-drop.ts`）

「待處理」不在側欄 drawer，而是仿 ⌘⇧P 的頂部浮層（`#attention-drop`，鈴鐺與 rail 鈴鐺都是 toggle）。
- 終端機 NSView 在 WebView 之上，靠 `overlay-cutout` 顯示；關閉時一定要送全零取消遮罩。
- 與片段面板共用單一 `cutoutRequests[label]`，不可同時開：開一個前先 `close(false)` 另一個（見 `toggleAttention`、`toggle-palette`）。
- 鍵盤：↑↓ 選卡片、Enter 前往、⌫ 忽略、Esc 關閉；輸入法組字中不處理。字體刻意放大（標題 16px／內文 14px），改 CSS 時別縮回去。
- 驗收：兩個鈴鐺皆可開關、浮層不被終端機蓋住且可點、關閉後終端機整面可點並取回焦點、與 ⌘⇧P 互斥。
- 重繪（`renderAttention`）會每 1.5 秒被掃描觸發：內容沒變就不重建（簽章比對），重建時要保留清單與各卡片 `.alert-body` 的捲動位置；重建後把焦點拉回浮層（被按的按鈕已消失），最後一張被忽略時自動關閉浮層。⌘⇧P 在浮層開著時只關浮層。
