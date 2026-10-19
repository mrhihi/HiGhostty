# 快速啟動組與「用其他工具開啟」

頁籤／收藏右鍵可：用全域「啟動組」（AI 工具＋模型＋額外參數）在該目錄開新頁籤、在 Finder 顯示、用自訂 App 開啟目錄。

## 資料
- 資料目錄 `launch-tools.json`：`{ "presets": [{id,name,tool,model,extra}], "openers": [{id,name,app}], "models": {工具id: [模型名…]} }`。`models` 覆蓋內建的模型清單（選單用），沒有該工具的項目就用內建；啟動時與編輯後由 `applyModels` 套用到 `AI_TOOLS`。檔案不存在 → 前端用 `DEFAULT_TOOLS`；存在就照內容（可為空）。`icons`：工具 id → 頁籤圖示（空／缺＝工具自己的圖示，`none`＝不顯示，其他工具 id＝借用該圖示，其他字串＝自訂文字如 emoji，最多 4 字）。壞項目逐筆丟棄，壞檔視為不存在。
- 正規化與組指令只放 `src/launch.ts`（`normalizeTools`、`presetCommand`、`validApp`），測試在 `tests/launch.test.mjs`。
- Rust `src-tauri/src/tools.rs`：`load_launch_tools`／`save_launch_tools`（原子寫入）與 `open_with_app`（`open -a <app> -- <dir>`，參數陣列、不經 shell；App 名稱不可以 `-` 開頭或含控制字元）。

## 前端
- `src/launch-settings.ts`：設定頁編輯區塊與同步快取 `launchTools()`。選單要同步建立，不可在開選單時才讀檔；視窗取得焦點時重讀。
- 選單項目由 `main.ts` 的 `launchMenuItems(path, { parentId })` 產生，頁籤列與收藏列共用；一律走 `popupMenu`（見 `docs/files-panel.md`）。
- 頁籤的啟動組新頁籤是該頁籤的子頁籤（同 `shellNewTab`），目錄取焦點 pane 的 cwd。

## 頁籤圖示
- 啟動命令指定 AI 工具（`parseLaunch`）的頁籤，列首以工具圖示取代狀態圓點；已結束變淡、待處理沿用警示色與脈動。設定頁「AI 模型清單」每個工具一列可改圖示。邏輯在 `launch.ts` 的 `resolveIcon`。

## 驗收清單（實機）
1. 設定頁新增兩組啟動組與一個 App，重啟後仍在；改語言後文字更新。
2. 頁籤右鍵選啟動組 → 同目錄開新子頁籤並執行對應指令；split 頁籤用焦點 pane 目錄。
3. 「在 Finder 中顯示」「用 VS Code 開啟」正確；App 不存在時出現錯誤通知。
4. 收藏列右鍵同樣有這些項目。
5. 選單開著時再右鍵不死結。
6. 把 `launch-tools.json` 弄壞 → 退回預設、不崩潰。
7. 啟動 AI 工具的頁籤列首是工具圖示（無圓點）；設定頁改成 none／其他工具／emoji 後立即反映（視窗重新取得焦點後亦同）。
