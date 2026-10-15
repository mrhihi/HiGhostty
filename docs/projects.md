# 專案區（S1：清單、成員、coordinator 討論；S2 純邏輯已完成）

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
- **成員候選**：只列「啟動指令是 claude／codex／copilot（含 `gh copilot`）／gemini、且在 tmux 執行」的頁籤的第一個窗格（`memberCandidates`、`agentKindOf`；只認單純形式，`cd x && claude` 之類不算；前置 `VAR=值` 可以）。建立專案時的 coordinator 種類也限這四種，讓身分（tmux session）在重開 App 後仍成立。手動在一般 shell 開的 agent 不能加入；窗格分割出來的 shell 也不列。
- **成員鎖定**：成為成員（含 coordinator）的頁籤，在「編輯頁籤」與「編輯收藏」裡啟動指令只能用清單選 agent（參數仍可自由輸入，`parseAgentCommand`／`buildAgentCommand`），tmux 勾選鎖住；移除成員後解除。App 啟動時 `loadKnownProjects()` 會載入索引內所有專案，重開後的成員頁籤才認得出來。Coordinator 一律用 tmux（建立表單沒有勾選框）。
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
5. 加入成員：候選只列啟動指令是上述四種 agent 且勾 tmux 的頁籤（一般 shell 頁籤不出現，選擇器有說明）；填名稱與用途；同一個終端機不能加兩次。「前往終端機」回到該頁籤並關掉專案畫面。
6. 重開 App：tmux coordinator 仍綁定；非 tmux 的成員顯示離線，可「重新啟動」或「改用其他終端機」。
7. 專案畫面開著時按 ⌘T／切頁籤／⌘W：鍵盤不會進到被隱藏的終端機；中文輸入法在討論框組字時 Enter 不會送出。
8. 唯讀資料夾／同步資料夾（路徑含 Mobile Documents）：顯示唯讀原因，不能送訊息。同一專案開兩個視窗：兩邊都看到新訊息，不重複投遞。
9. 預覽窗、files panel、⌘⇧P、待處理浮層與專案畫面切換後版面都正常，標題列仍可拖曳。
10. 側欄「×」只從清單移除，資料夾與 journal 不動；再用「開啟既有專案」可開回。
11. 全域控制模式為「唯讀」或「關閉」時，專案畫面頂端顯示需完整模式的提示與「開啟設定」；改成「完整」後 3 秒內提示消失。
12. 成員（含 coordinator）頁籤的「編輯頁籤」：啟動指令是 agent 下拉＋參數、tmux 勾選灰掉且已勾；從專案移除成員後恢復一般輸入。對應收藏的「編輯收藏」同樣鎖住。重開 App 後鎖仍在。

## S2 純邏輯（`src/project-tasks.ts`，測試 `tests/project-tasks.test.mjs`）

尚未接 UI、`ctl` 指令與投遞；只有規則。`projects.ts` 的 `decide`／`reduce` 把 S2 的 action 轉給 `decideTasks`／`reduceTasks`。

- **範圍**：`SubmitPlan`、`StartRun`、`PauseRun`／`ResumeRun`、`PrepareDispatch`、`RecordInputStart`／`RecordInputResult`、`ReceiveReport`、`AcceptResult`、`RequestRework`、`RequestCancel`、`RetryTask`、`ReconcileTask`，以及 `validatePlan`、`eligibleTasks`、`queueReasonOf`、`buildTaskPayload`。
- **還沒做**：`ReplyIssue`（回覆 needs-input）、`ObservedBlocked`、`SubmitObservedResult`、`DeliverNow`、跨專案 reservation（S3）、結案部分取消的 run、「auto-on-protocol-result」驗收。
- **與規格不同**：artifact 文字直接放進 journal 事件（沒有獨立檔案與 sha256）；一個專案只有一個 plan id，每次提交是新版本；同一專案內一位成員同時只接一個任務，`result-ready` 即釋放。
- **不變式（測試涵蓋）**：沒有回報不改變狀態；舊 attempt 的回報只留紀錄、不動新 attempt；沒有 `InputWillStart` 就收到的回報標 `unmatched`、不推進、不存成果；`uncertain` 不能直接重試；`needs-input` 的 Issue 在後續 progress／result／終結回報時自動關閉；coordinator 驗收必須逐項對上完成條件並附屬於該任務的成果 ID。
- `reportId` 為不透明字串，去重鍵是 taskId＋attemptId＋reportId，相同 ID 內容不同回 `report_conflict`。

### S2 的 `ctl project` 指令

`plan submit`、`run start`、`run pause`、`task get`、`task result`、`task report`、`task accept`、`task rework`（連同 S1 的 `get`／`inbox`／`hello`／`message`）。解析在 `src/project-control.ts`，接線在 `src/project-ctl.ts`，指令表在 `src/control.ts`，測試 `tests/project-ctl-tasks.test.mjs`。

- coordinator 專用：`plan submit`、`run start`、`run pause`、`task result`、`task accept`、`task rework`。成員專用：`task get`（只能讀指派給自己的任務）、`task report`。
- `run start` 只會建立「引用使用者訊息」的同意；沒有對應的使用者訊息回 `needs_user_decision`（使用者要從畫面按「開始」）。
- `task report` 的 actionId 是 `report:<taskId>:<attemptId>:<reportId>`，重送同一份是 no-op；回應的 `stale` 非空表示被保存但沒有生效。
- **與規格不同**：多了 `task result`（規格只讓成員讀 `task get`，但 coordinator 驗收前必須能讀成果）。
- 已接畫面（見下一節）。

## S2 畫面與交付（`src/project-run-view.ts`、`src/project-panel.ts`）

- **畫面**：成員下方的「計畫」區：最新計畫版本（步驟、負責人、相依、完成條件）、「開始」（列出阻礙：coordinator 未 hello、成員未綁定）、暫停／繼續、任務卡。任務卡依狀態顯示：交付、取消、提問與回答框、核對 uncertain（沒收到／正在做／失敗）、成果（`textContent` 顯示，不當標記）與驗收／退回（必填意見）、重試。草稿存在 `drafts`，重畫不會丟。
- **交付流程**（`deliverTask`）：`PrepareDispatch` → `sendPrompt`（idle 檢查通過後才呼叫 `beforeInput`，即 `RecordInputStart` 寫入 journal）→ 輸入 → `RecordInputResult sent`。檢查沒過（忙碌／blocked／不在線）：不輸入，記 `not-sent` 回到佇列。輸入開始後出錯：記 `unknown`（任務變 uncertain，需人核對）。
- **回覆提問**（`ReplyIssue`）：使用者回答後排進 `replies`；`deliverReplies` 對仍在 `needs-input` 的任務、且 attempt 相符者，用 `replyPrompt` 通知 worker，答案本身由 `project task get` 的 `replies` 讀取（prompt 不放內文）。舊 attempt 或已離開等待的回覆不會再被輸入。
- **prompt**：`taskPrompt`（`[HiGhostty project task protocol v1]`）只放標頭、ID、一行目標、讀取與回報指令，不放任務資料與指令內文。
- 一次只投遞一份（`delivering` 旗標，與討論訊息共用）；只有持有成員終端機的視窗能交付。

### S2 驗收（實機，加在上面清單之後）

13. 請 coordinator 提交計畫（`plan submit`）：計畫區出現步驟；錯誤的計畫回 `invalid_plan` 並列出全部問題；coordinator 未 hello 或成員未綁定時「開始」灰掉並寫明原因。
14. 按「開始」：任務出現；第一步可「交付」，第二步顯示等待前一步。
15. 按「交付」：worker 收到 `[HiGhostty project task protocol v1]` prompt，用 `task get` 讀到資料並以 `task report` 回報；任務依序變成已送出／進行中／成果待驗收。worker 忙碌或停在核准畫面時按交付：不輸入任何東西，任務回到等待，並顯示原因。
16. 成果待驗收：可展開看附件；「驗收通過」後下一步可交付；「退回重做」要填意見，重新交付後 `task get` 有 `rework`。全部驗收後顯示「計畫已完成」。
17. worker 回 `needs-input`：任務卡顯示提問，回答後 worker 收到通知並用 `task get` 讀到 `replies`，繼續後回 progress／result。
18. 在輸入進行中強制結束 App 再開：任務是 uncertain，不會自動重送；選「沒收到」回到等待、「正在做」或「標為失敗」。
19. worker 的核准被拒、只回到 idle 沒有回報：任務維持原狀，不會被判成功或失敗。
20. 暫停後不能再交付；繼續後恢復；取消進行中的任務只記錄要求，不自動中斷 worker。
