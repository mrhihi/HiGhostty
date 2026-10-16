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

**agent 自己發的提示**：`highostty ctl alert raise`（`docs/agent-control.md`）產生來源 `agent` 的 alert，優先度最高（`signal` < `prompt` < `agent`）。畫面偵測不會覆蓋或清除它（`clearSource` 只清自己的來源）；「忽略」agent 提示不會寫入 `dismissed`（那是畫面偵測的去重記錄）。

## 在卡片上直接選選項
畫面辨識出的單選選單會在卡片上列出選項按鈕（`menuAnswerable`）。條件很嚴：提示必須是 `exact`（`numberedMenu` 的 `exactBlock`）——選項是游標所在的**連續編號區塊、編號 1..n 遞增、只有一列有游標**，選項不是核取方塊（含 `1. [ ]` 這種帶編號的）、沒有「Type something／Chat about this」之類要打字的選項；另外種類須是 `menu`／`confirm`／`trust`、非低信心、2～9 個選項。畫面上別處的編號清單、回聲的 `> 1. …`、每列都有圓點的單選清單、選項間夾說明行的清單，一律不給按鈕。`confirmMenu`（「Enter to confirm」頁尾、無編號）不會是 `exact`，所以從不給按鈕。
點選＝游標移到該列再 Enter，只用既有的 `key` op（↑／↓／Enter，每鍵間隔 60ms），**沒有改 `bridge.m`／`HGSurface`**（`docs/keyboard-input.md` 的規則不受影響）。
- 送出前（`answerPrompt`）先重新 `scan`，提示的 `promptKey`（種類、問題、選項、游標列）必須與卡片上的一致（`sameMenu`），否則什麼都不按，提示使用者看新內容並重畫卡片。
- 方向鍵送完後**再掃一次**，確認還是同一個選單（`promptIdentity`）、游標確實在選定那列、仍是 `exact`，才送 Enter；不符就不送 Enter，維持上鎖並通知（方向鍵已送出，不補救、不重試）。`native` 回 `{error}` 視為失敗。
- 上鎖（`answering`）以選單身分（不含游標列）為準：自己送的方向鍵讓游標移動不會解鎖；按鈕停用，直到選單消失或內容改變，或逾時（`ANSWER_LOCK_MS`，15 秒）才解鎖；不會自動補 Enter 或重試。
- 不處理：密碼／登入／自由輸入／y-n／press-enter／低信心提示（只提供「前往」）。
- 已知限制：tmux 頁籤的窗格若在 copy-mode（捲動中），↑↓ 會變成捲動、Enter 會離開 copy-mode，而畫面仍可能辨識出舊提示；卡片目前不檢查 tmux 狀態。
- 驗收（debug 與 release 各一次，**`npm test` 不涵蓋**）：(1) 背景頁籤的 Claude Code 跳出權限選單，卡片出現選項按鈕，點第 2 項後該終端機選到第 2 項並確認，卡片消失；(2) 點之前先在該終端機用方向鍵移動游標（或讓畫面變化），點選項後不按任何鍵、出現「提示已變」通知；(3) 連點兩次只送一次；(4) 試 Codex／Gemini 的選單與 tmux 頁籤；(5) 中文輸入法開著、焦點在別的終端機時，送出不影響輸入；(6) 密碼提示、低信心提示、核取方塊清單、畫面上方另有編號清單的選單沒有選項按鈕；(7) tmux 頁籤的 Claude Code 選單可以選，且 copy-mode 中不要試。

## 辨識規則（資料，可維護）
- 內建：`src/prompt-rules.json`（隨 App 打包）。
- 使用者覆蓋：資料目錄下的 `prompt-rules.json`（`HIGHOSTTY_DATA_DIR` 可隔離）。設定頁「提示辨識規則」可「開啟規則檔」（不存在時寫入範本）與「重新載入」。
- 合併：使用者規則排在內建前面；`id` 與內建相同即取代；`disable: ["id"]` 停用內建規則；`agents`、`footers` 追加。
- 使用者檔 JSON 壞掉、regex 編譯失敗、未知 `kind` 等：整份使用者規則忽略、退回內建，原因顯示在設定頁。

檔案欄位：
- `agents`：agent 行程名（regex 片段，比對行程名開頭）。Claude Code 原生版的行程名是版本號（如 `2.1.296`），所以內建含版本號樣式。tmux 頁籤改問 tmux 窗格的前景指令（`tmux_panes`），因為原生終端機只看得到 tmux client。
- `footers`：最後一行命中就不提示（正常執行頁尾，例如 `esc to interrupt`）。regex，不分大小寫。
- `working`：最後 12 行任一行命中，`agentState` 視為執行中（內建 `esc to interrupt`）。與 `footers` 分開，因為 `? for shortcuts` 這類頁尾 idle 時也會出現。regex，不分大小寫，使用者檔追加。
- `idle`：關閉確認時「閒置、不算仍在執行」的行程，陣列元素 `{ "name": 行程名（完全相符）, "args": [命令列必須全部包含的字串] }`，`args` 可省略。內建含 dotnet 建置伺服器（`VBCSCompiler`、MSBuild node reuse、Razor server）；使用者檔追加。載入規則後前端送 `idle-rules` op 給原生，`bridge.m` 的 `processInfo` 用它從「仍在執行」清單剔除行程；這些行程仍留在 `pids`，強制關閉時一樣會被終止。命令列用 `sysctl KERN_PROCARGS2` 讀取，只在 `name` 相符時才讀。
  - 驗收（**`npm test` 不涵蓋**）：(1) 終端機跑一次 `dotnet build`，關頁籤不跳確認，`VBCSCompiler` 與 MSBuild node 隨頁籤結束；(2) 同頁籤跑 `dotnet watch` 或 `sleep 100`，關頁籤仍跳確認；(3) 在使用者規則檔 `idle` 加 `{"name":"sleep"}` 後重新載入，`sleep 100` 不再跳確認；(4) 規則檔 `idle` 寫錯（如 `{}`）時設定頁顯示原因並退回內建。
- `rules`：依序比對，第一個命中者勝出。每條：
  - `id`（唯一）、`kind`（`menu`／`yesno`／`confirm`／`press-enter`／`password`／`login`／`trust`／`input`）、`label`（顯示文字）
  - regex 規則：`scope`、`pattern`、`flags`。`scope` 決定看畫面哪一塊：
    - `last` 最後一行（預設）、`tail` 最後 12 行
    - `after-rule` 最後一條 `─` 水平線之後；沒有水平線時為整個畫面
    - `box-body` 最後兩條水平線之間（輸入框內容）；少於兩條時為空
    - `above-box` 輸入框上方（倒數第二條水平線之前，取最後 12 行）；沒有輸入框時為整個畫面的最後 12 行
    - 水平線：`─` 開頭，且連續 3 個以上，或整行只有 `─`
  - `not`：regex 陣列（不分大小寫）。範圍內任一行命中就整條規則不成立；`scope` 為 `last` 時看最後 12 行。用來排除互斥畫面。
  - layout 規則：`layout` 為 `cursor-menu`（游標＋編號選項）或 `confirm-menu`（`confirmText` 頁尾加游標清單），解析選項與選取項的程式在 `recognizePrompt`
  - `confidence: "low"`：低信心，頁籤與卡片以「等待？」樣式顯示

任何規則命中時，若畫面上有游標＋編號選項，會一併帶出問題、選項與選取項。

## agent 狀態（`agentState`）
`agentState(text, title, rules)` 回傳 `blocked`／`working`／`idle`，判定只放在 `src/attention.ts`：
1. `recognizePrompt` 有結果 → `blocked`（低信心也算，避免對未知提問送輸入）
2. 標題 spinner（點字元或半圓 ◐◑◒◓）或 `working` 規則命中 → `working`
3. 其餘 → `idle`

標題 spinner 除了點字元，也認 Claude Code 2.1.228 起使用的半圓字元。

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
- 重繪（`renderAttention`）會每 1.5 秒被掃描觸發：內容沒變就不重建（簽章比對，含問題與選項），重建時要保留清單與各卡片 `.alert-body` 的捲動位置與「畫面內容」`<details>` 的展開狀態（預設收合，記在 `expandedBodies`）；重建後把焦點拉回浮層（被按的按鈕已消失），最後一張被忽略時自動關閉浮層。⌘⇧P 在浮層開著時只關浮層。
