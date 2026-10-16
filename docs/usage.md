# 用量指示（Claude Code / Codex）

視窗最下方 footer 最右邊顯示兩個產品的「近 5 小時」與「近一週」用量百分比，點擊後浮出細節。

## 資料來源
- **Codex**：`usage_codex` 讀 `~/.codex/sessions/**/rollout-*.jsonl`，取修改時間最新的幾個檔案，由尾端（最後 512KB）往前找最後一筆 `token_count` 的 `payload.rate_limits`。`primary` 是 5 小時、`secondary` 是一週；`resets_at` 為 epoch 秒。數值只會在 Codex 跑過對話後更新；`resets_at` 已過視為已重置（顯示 0%）。不讀 `auth.json`。
- **Claude Code**：`usage_claude` 以 `security find-generic-password -s "Claude Code-credentials" -w` 取得登入 token，再用 `curl` 呼叫 `https://api.anthropic.com/api/oauth/usage`（`anthropic-beta: oauth-2025-04-20`）。回應的 `five_hour.utilization`、`seven_day.utilization` 與 `resets_at`（ISO 字串）。這是未公開端點，欄位日後可能變動；解析失敗回 `bad-response`。
  - token 只在記憶體：透過 `curl -K -` 由 stdin 傳入，不出現在行程參數列；不寫檔，錯誤只回代碼。
  - 這個端點限流很嚴：實測連續兩次請求就會 429（`retry-after: 0`，沒有參考價值）。所以 Rust 端不論成功或失敗都快取 3 分鐘（所有視窗共用），手動「重新整理」至少間隔 30 秒。
  - 429 回 `rate-limited`。若之前成功過，繼續顯示上次的數字並附警告（`warning`），沒有舊值才顯示錯誤。
  - 首次讀取 macOS 會要求授權。
  - 細節浮層底部的核取方塊可關閉 Claude 用量（`localStorage` 的 `usage-claude`），關閉時完全不讀鑰匙圈。

## 更新頻率（盡量少動畫面）
- 每個視窗每 3 分鐘輪詢一次（只在視窗可見時），與 Rust 快取同步；開很多視窗也不會多打 API。
- 不在視窗聚焦或開啟浮層時主動重抓（資料超過 3 分鐘才抓）；只有按「重新整理」才強制。
- 每分鐘只更新倒數文字；按鈕內容沒變就不動 DOM，浮層裡正在操作控制項時不重畫。

## 已用／剩餘切換
細節浮層標題列右側的切換鈕可在「已用」與「剩餘」之間切換；按鈕、進度條與百分比一起換算（剩餘 = 100 − 已用，`displayPct`）。選擇存在 `localStorage` 的 `usage-mode`（`used`／`left`），重開 App 後保留。變色一律依「已用量」判斷，不受顯示模式影響。

## 顏色
`src/usage.ts` 的 `WARN_AT = 70`、`DANGER_AT = 90`：≥70% 黃（`--attention`）、≥90% 紅（`--danger`），按鈕上的數字與細節的進度條都套用。

## 細節浮層與遮罩
浮層在 `#workspace` 右下角，終端機 NSView 在 WebView 之上，所以靠 `overlay-cutout` 顯示（做法同 `src/attention-drop.ts`）。`cutoutRequests` 每視窗只有一格：開啟時 `closeOthers` 會關掉片段面板與待處理浮層，反過來開啟那兩個前也要呼叫 `usageBar.close(false)`。關閉時送全零取消遮罩。

## 驗收清單（實機，debug 與 release 都要）
1. footer 最右邊顯示 Claude 與 Codex 的 5h／7d 百分比；Codex 剛跑過對話後數字會更新。
2. 暫時調低 `WARN_AT`／`DANGER_AT`，確認數字變黃、變紅，進度條同色。
3. 點擊浮出細節，不被終端機蓋住；Esc、點外面、視窗失焦都會關閉，關閉後焦點回終端機。
4. 開著細節時按 ⌘⇧P 或點鈴鐺，細節先關閉；反過來開著待處理浮層時點用量按鈕也正常。
5. 取消 Claude 用量核取方塊：Claude 欄位消失、不再讀鑰匙圈；重新勾選後恢復。
6. 拒絕鑰匙圈授權、離線、未安裝 Codex：顯示「—」與錯誤說明，App 不崩潰。
7. 切換語言，按鈕與細節文字即時更新。
8. 切換「剩餘」：數字與進度條變成 100 − 已用，顏色不變（高用量仍是紅／黃）；重開 App 後維持。
9. 確認 token 不出現在畫面、日誌或 `ps` 的參數列。
