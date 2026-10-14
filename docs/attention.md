# 待處理提示（響鈴／agent 等待輸入）

背景頁籤的終端機需要你時，頁籤列會標色並顯示類型（例如「等待核准」），標題列鈴鐺顯示數字，「待處理」面板可不切頁籤直接看問題、選項與當時的畫面。

沒有 hook 機制；agent 不需要安裝任何東西。

## 偵測分層（`src/attention.ts`，越上層越明確）
1. **prompt**：`scan` op 讀 VIEWPORT 文字並判斷子行程是否為 agent；`recognizePrompt` 依規則辨識畫面上的提示（類型、問題、選項、目前選取項）。
   - 追蹤的是「提示本身」的指紋，不是整個畫面：提示不變、畫面其他地方（spinner、時鐘）在動，不會重置計時。
   - 畫面曾變動過、提示穩定 `QUIET_MS`（1.4 秒，約連續兩次掃描）才提示。一打開就停在提示的畫面要等它變動過才算。
   - 同一個提示不會重複提示；按「忽略」後，同一個提示不再出現，提示變了才會再提示。
2. **signal**：`bridge.m` 的 `RING_BELL`、`DESKTOP_NOTIFICATION` 會 emit `bell`／`notify`；標題 spinner（點字元）消失視為 agent 停下。
   - 之後若辨識出具體提示，`prompt` 會取代 `signal`。

**畫面快照**：每次提示產生時，前端用 `scan` 擷取該終端機 VIEWPORT 末 15 行存進 alert（`screen`），「待處理」卡片顯示「問題＋選項＋當時的畫面」；之後畫面變動也不會被覆蓋。

使用中且視窗聚焦的頁籤不產生提示；切到頁籤或視窗取得焦點會清除。

## 辨識規則（資料，可維護）
- 內建：`src/prompt-rules.json`（隨 App 打包）。
- 使用者覆蓋：資料目錄下的 `prompt-rules.json`（`HIGHOSTTY_DATA_DIR` 可隔離）。設定頁「提示辨識規則」可「開啟規則檔」（不存在時寫入範本）與「重新載入」。
- 合併：使用者規則排在內建前面；`id` 與內建相同即取代；`disable: ["id"]` 停用內建規則；`agents`、`footers` 追加。
- 使用者檔 JSON 壞掉、regex 編譯失敗、未知 `kind` 等：整份使用者規則忽略、退回內建，原因顯示在設定頁。

檔案欄位：
- `agents`：agent 行程名（regex 片段，比對行程名開頭）。Claude Code 原生版的行程名是版本號（如 `2.1.296`），所以內建含版本號樣式。tmux 頁籤改問 tmux 窗格的前景指令（`tmux_panes`），因為原生終端機只看得到 tmux client。
- `footers`：最後一行命中就不提示（正常執行頁尾，例如 `esc to interrupt`）。regex，不分大小寫。
- `rules`：依序比對，第一個命中者勝出。每條：
  - `id`（唯一）、`kind`（`menu`／`yesno`／`confirm`／`press-enter`／`password`／`login`／`trust`／`input`）、`label`（顯示文字）
  - regex 規則：`scope`（`last` 最後一行，預設；`tail` 最後 12 行）、`pattern`、`flags`
  - layout 規則：`layout` 為 `cursor-menu`（游標＋編號選項）或 `confirm-menu`（`confirmText` 頁尾加游標清單），解析選項與選取項的程式在 `recognizePrompt`
  - `confidence: "low"`：低信心，頁籤與卡片以「等待？」樣式顯示

任何規則命中時，若畫面上有游標＋編號選項，會一併帶出問題、選項與選取項。

新增或調整規則時：補 `tests/attention.test.mjs` 案例，並確認內建檔通過 `tests/prompt-rules.test.mjs`。

## 驗收清單
- 背景頁籤 `sleep 3; printf '\a'` → 頁籤列標色＋鈴鐺 +1；切到該頁籤後消失。
- `printf '\e]9;hi\a'` 出現通知項目。
- 背景頁籤的 agent（Claude Code／Codex／Gemini）跳出權限、計畫核准、工作區信任詢問，數秒後卡片顯示類型、問題、選項與選取項；回答後清除。
- 背景頁籤 `printf 'Continue? [y/N] '; sleep 60`、`read -p "Password: "` 分類正確。
- 卡片顯示當時畫面；agent 繼續執行、畫面改變後該卡片內容不變。
- 「忽略」後同一個提示不再跳出。
- agent 執行中（頁尾 `esc to interrupt`）不誤報；20+ 頁籤不卡；標題列拖曳正常（`docs/window-drag.md`）。
- 在使用者規則檔新增一條規則並「重新載入」立即生效；寫壞規則檔時設定頁顯示原因、偵測仍用內建規則。
- debug 與 release 都要試。

## 待處理浮層（`src/attention-drop.ts`）

「待處理」不在側欄 drawer，而是仿 ⌘⇧P 的頂部浮層（`#attention-drop`，鈴鐺與 rail 鈴鐺都是 toggle）。
- 終端機 NSView 在 WebView 之上，靠 `overlay-cutout` 顯示；關閉時一定要送全零取消遮罩。
- 與片段面板共用單一 `cutoutRequests[label]`，不可同時開：開一個前先 `close(false)` 另一個（見 `toggleAttention`、`toggle-palette`）。
- 鍵盤：↑↓ 選卡片、Enter 前往、⌫ 忽略、Esc 關閉；輸入法組字中不處理。字體刻意放大（標題 16px／內文 14px），改 CSS 時別縮回去。
- 驗收：兩個鈴鐺皆可開關、浮層不被終端機蓋住且可點、關閉後終端機整面可點並取回焦點、與 ⌘⇧P 互斥。
- 重繪（`renderAttention`）會每 1.5 秒被掃描觸發：內容沒變就不重建（簽章比對，含問題與選項），重建時要保留清單與各卡片 `.alert-body` 的捲動位置；重建後把焦點拉回浮層（被按的按鈕已消失），最後一張被忽略時自動關閉浮層。⌘⇧P 在浮層開著時只關浮層。
