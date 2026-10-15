# 專案區（S1：清單、成員、coordinator 討論）

規格見 `docs/project-implementation.md`；本文記錄 S1 實際做了什麼、與規格不同之處、以及驗收清單。S1 沒有計畫、run、任務、自動派送。

## 架構

- **規則**：`src/projects.ts`（`decide`／`reduce`／`replay`／`inboxFor`）與型別 `src/project-types.ts`，測試 `tests/projects.test.mjs`。純邏輯、DOM-free，不產生 ID、不讀檔。
- **儲存**：`src-tauri/src/projects.rs`。每個專案根目錄 `.highostty/journal/events.jsonl` 是唯一權威（每行 `{checksum, tx}`），`local/lock` 以 `flock` 保證單一寫入者。`project_commit` 先檢查 actionId 去重，再檢查 `expectedRevision`，寫入並 `sync_data` 後才回成功、才發 `project-changed`。尾端半行會備份成 `tail-*.bak` 後截回；中段損毀或 revision 不連續則整份唯讀；同步資料夾（iCloud／Dropbox…）預設唯讀。索引在資料目錄 `projects-index-v1.json`，移除只忘記，不動專案資料夾。
- **TS 串接**：`src/project-store.ts`。任何視窗都能開專案與寫入；衝突時重新 `decide` 再送（最多 3 次，同一 actionId）。
- **指令**：`src/control.ts` 的 `project get|inbox|hello|message`；解析、回覆、caller→member 在 `src/project-control.ts`，接線在 `src/project-ctl.ts`。`--json-stdin`：CLI 讀 stdin（上限 256 KiB）放進 socket request 的 `input`，由 TS 解析。
- **UI**：`src/project-panel.ts`。側欄 `#project-list`（在 `#tabs` 上方）、`#project-view`（`#files` 之後）。
- **prompt**：`src/project-prompts.ts`，只含標頭與 ID，不含訊息內文；coordinator 自己用 `project inbox` 讀。

## 與規格不同（S1 的簡化）

- **沒有 owner／epoch／heartbeat**：journal 的 revision CAS 與 `flock` 已足夠序列化；S3 才需要 owner。
- **instance 身分**：沒有 `HIGHOSTTY_INSTANCE_ID`，改用 `instanceKey`：tmux 頁籤是 `tmux:<session>`（重開 App 後仍認得），其他是 `surface:<id>`（重開後顯示離線，需重新綁定或「重新啟動」）。generation 固定 1。
- **專案內容切換**：不做 `ContentState`，比照檔案面板的全版模式：`updateLayout()` 把專案視為 `terminalHidden()`，送空 rects；`native()` 在專案開著時略過 `focus` op。S2 前要評估是否改成規格的 `ContentState`。
- **沒有 `project.json` 快照、artifact、`prevHash`**。
- **投遞**：只由「持有 coordinator 終端機的視窗」投遞；idle 才送；寫入 `sending` 之後不自動重送（失敗標 `uncertain`）。

## 注意

- 訊息投遞的 `sending` 必須在任何輸入前寫入 journal（`sendPrompt` 的 `beforeInput`）。
- hello 不覆蓋使用者自己寫的用途；重新綁定會清掉舊 hello。
- `project message` 的 `messageId` 兼作 actionId，agent 重送同一則是 no-op。
- 專案面板不得重建輸入框（草稿）；重畫以 `signature()` 比對，沒變就不畫。
- 新增使用者可見字串：`src/locales/{en,zh-Hant}/project.json`。

## 驗收清單（debug 與 release 各一次；`npm test`／`cargo test` 不涵蓋）

1. 側欄 `+` →選資料夾、填名稱、勾 tmux → 建立：出現專案畫面；背景開一個 coordinator agent 頁籤（不搶畫面）；它收到自我介紹 prompt 並呼叫 `project hello`，卡片變「就緒」。
2. `project get <id>`（唯讀模式也可）回成員與 handshake；`project hello`／`message` 在唯讀模式回 `forbidden`。
3. 在討論區送訊息：先「等待 coordinator」→「送出中」→「已送出」；coordinator 收到通知後用 `project inbox` 讀並 `project message --json-stdin` 回覆，原訊息變「已回覆」。coordinator 忙碌時訊息留在「等待」，閒置後才送；blocked 時不送。
4. 重送同一個 messageId 的 `project message` 不會產生第二則。
5. 加入成員：選一個開著的終端機，填名稱與用途；同一個終端機不能加兩次。「前往終端機」回到該頁籤並關掉專案畫面。
6. 重開 App：tmux coordinator 仍綁定；非 tmux 的成員顯示離線，可「重新啟動」或「改用其他終端機」。
7. 專案畫面開著時按 ⌘T／切頁籤／⌘W：鍵盤不會進到被隱藏的終端機；中文輸入法在討論框組字時 Enter 不會送出。
8. 唯讀資料夾／同步資料夾（路徑含 Mobile Documents）：顯示唯讀原因，不能送訊息。同一專案開兩個視窗：兩邊都看到新訊息，不重複投遞。
9. 預覽窗、files panel、⌘⇧P、待處理浮層與專案畫面切換後版面都正常，標題列仍可拖曳。
10. 側欄「×」只從清單移除，資料夾與 journal 不動；再用「開啟既有專案」可開回。
11. 全域控制模式為「唯讀」或「關閉」時，專案畫面頂端顯示需完整模式的提示與「開啟設定」；改成「完整」後 3 秒內提示消失。
