# 專案區（S1 成員與討論、S2 計畫與任務、S3 自動派送）

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
- **從頁籤／收藏加入專案**：「編輯頁籤／編輯收藏」的「加入專案」選一個專案，填名稱與負責什麼，加入為 worker 成員（`joinProject`；同專案可有多個收藏）。身分是 tmux session：收藏會存一個固定的 session 名稱（`tab.tmuxSessions[0]`），所以**終端機沒開也能先加入**，成員顯示離線；專案畫面的成員卡有「開啟終端機」（`favoriteForInstance`）開對應收藏，開啟後同一個 session 自動上線。已是成員時名稱唯讀、負責內容可改。命令必須是 agent，tmux 強制開啟。舊收藏只有 `coordinatorRoot` 還沒加入的，下次開啟時自動加入（`autoJoin`）並把 session 記回收藏。勾選後啟動指令只能從清單選 agent（`tab.coordinator` 旗標仍存）。
- **啟動指令判斷**：`agentKindOf` 先看字面，認不出再用 `resolve_program`（登入 shell 的 `where`，非 zsh 用 `command -v`）解析別名／symlink／路徑檔名，結果快取在 `main.ts` 的 `programNames`。
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
- 原先列為未做的項目已在下面「S3」一節完成。
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

### 需要人處理（卡在核准畫面、沉默太久）

- **與規格不同**：規格把 `ObservedBlocked`／`delivery-unknown` 做成寫進 journal 的 Issue。這裡改成**由即時觀測與時間推導、不寫 journal**（`blockedMembers`、`stalledTasks`，在 `src/project-tasks.ts`）：它們是「現在的狀況」，寫進去會在重開後留下過期的 Issue，也會讓 journal 隨畫面閃動而膨脹。代價：沒有「已讀／已解決」的持久紀錄；回報提問（`needs-input`）仍是持久 Issue。
- **blocked**：計畫區頂端「需要你處理」，只列有進行中任務的成員，只提供「前往終端機」；專案不會代按任何鍵。畫面觀測由 `host.observe`（`scanScreens`＋`agentState`）每 3 秒讀一次，只在專案畫面開著且有進行中任務時讀。
- **沉默**：`sent`／`accepted`／`running` 的任務自上次動靜（交付、狀態變化、有效回報）起超過 10 分鐘（`DEFAULT_STALL_MS`，無實測依據，待調整）就提示。**不改變任務狀態**；使用者可「前往終端機」、「它沒有收到」（回到等待）或「標為失敗」。為此 `ReconcileTask` 也允許用在 `sent`／`accepted`／`running`（原本只有 `uncertain`）。舊 attempt 的遲到回報不算動靜。

21. worker 停在核准畫面：計畫區頂端出現「需要你處理」並可前往終端機，專案沒有按任何鍵；你處理後提示消失，任務仍由回報推進。
22. 交付後不理它超過 10 分鐘（可暫時把 `DEFAULT_STALL_MS` 改小測）：出現沉默提示，任務狀態不變；選「它沒有收到」回到等待、「標為失敗」變失敗，worker 之後的遲到回報被標為過期而不動新狀態。

## S3：自動派送、人工暫停、恢復、跨專案排隊

規則：`src/project-schedule.ts`（`verdict`／`nextDeliverable`／`busyElsewhere`，測試 `tests/project-schedule.test.mjs`）、`src/project-hold.ts`（manualHold，同測試檔）、`src/project-tasks.ts`（`SetRunAuto`、`CloseRun`、`RecoverTasks`、`SubmitObservedResult`／`ConfirmObservedResult`、自動驗收）。接線：`src/project-delivery.ts`（唯一的交付通道，pump 與按鈕共用）、`main.ts` 的 `sendPromptToAgent`。

- **自動交付是每個 run 的開關**（開始時勾選，預設勾；之後可切換）。pump 每 1 秒對所有已載入的專案跑一輪，**一個視窗只處理自己持有終端機的成員**；全程序列化（一個佇列），同時間只會對一個終端機輸入。
- **判斷順序**（`verdict`）：任務規則（暫停／結案／相依／忙碌／未綁定）→ 控制模式非「完整」→ 終端機不在線 → 同一個 agent 在別的專案有進行中任務 → 螢幕是 blocked（**任何情況都不輸入**）→ 螢幕上沒有 agent（不輸入）→ 人工暫停 → 畫面讀數超過 5 秒 → agent 忙碌。人按「現在交付」只略過最後三項（暫停、讀數過舊、忙碌）。
- **輸入前**：`sendPromptToAgent` 連兩次（間隔 500 ms）確認 idle，再 `beforeInput`（journal 寫 `InputWillStart`）、貼上、Enter。任何一步呼叫後出錯記 `unknown`（任務變 uncertain，不重送）。
- **人工優先**：`main.ts` 每秒回報使用者正在看哪些終端機（專案畫面開著、視窗失焦時都算沒在看）。看著成員的終端機立刻 hold；離開後連續 idle 10 秒（`RELEASE_QUIET_MS`）才解除；畫面頂端顯示「N 個任務因人工操作暫停」與「交回專案」。blocked／unknown 不會解除 hold。
- **跨專案排隊**：同一個 instance 被兩個專案綁定時，由 `busyElsewhere`（讀所有已載入專案的任務狀態）決定先後，**不需要另外的 reservation 狀態**——重開 App 後從 journal 自然還原。
- **恢復**（`recoverAll`，只由 main 視窗在啟動時執行一次）：`dispatching` 且尚未 `InputWillStart` → 回到 queued；已 `InputWillStart` → uncertain；`sent` 以後的維持原狀（之後靠回報或畫面觀測）。
- **自動驗收**：步驟可設 `acceptance: "auto-on-protocol-result"`（成員用協定回報 result 即通過）、`"user"`、預設 coordinator；`externalWrite: true` 標示會寫外部系統。`validatePlan` 拒絕「下游（含間接）有 externalWrite 的步驟，上游自動驗收」，也拒絕對 `screen` 成員設自動驗收。取消請求之後才到的 result 一律等人驗收。
- **畫面追蹤成果**：成員無法用協定回報時（`reportMode: screen`），coordinator 用 `ctl project task observed` 記下畫面上的成果（附件標「由畫面整理」）；使用者按「確認為成果」才進入 `result-ready`，之後仍走驗收。
- **結案**：「結案」（`CloseRun`）只在沒有進行中或待驗收的任務時可用，保存 `unfinished` 清單；結案後才能對新計畫版本重新開始。

### 與規格不同（S3）

- **沒有 Rust 的 owner／epoch／heartbeat／RuntimeRegistry／effect 路由**。理由：journal 的 revision 檢查加上「只有持有終端機的視窗才會對它輸入」已能避免重複派送（兩個視窗搶同一個任務時，`PrepareDispatch` 會因狀態已變而被拒）；跨專案排隊與重開後的 reservation 都由 journal 狀態推導。代價：持有成員終端機的視窗關掉時，該成員的任務不會被推進（成員本來就離線）。
- `DeliverNow` 不允許用在 blocked（規格寫「略過 busy／blocked／manual」；對 blocked 輸入等於替使用者回答詢問）與沒有 agent 的畫面。
- 沒有 `project.json` 快照；artifact 內嵌於 journal（見 S2）。

### 獨立審查後的修正

- 同一任務在回答後再次 `needs-input`：原本被當成過期回報丟掉；現在關掉舊提問、開新提問。
- 討論訊息與提問回答的投遞：輸入前失敗退回 `queued`（會再試），輸入開始後才標 `uncertain`；重開後仍停在 `sending` 的項目由 `recoverAll` 標 `uncertain`。這兩種投遞現在也遵守人工暫停，且控制模式不是「完整」時不輸入。
- 自我介紹 prompt 改走 `delivery.intro`：與其他輸入排同一個佇列、遵守人工暫停。
- `RecordInputStart` 會再檢查 run 狀態：交付準備好之後若被暫停或結案，不會再輸入（`handOver` 回到 queued）。
- `PrepareDispatch` 提交後若追上最新狀態時出錯，會釋放該交付，不會卡在 dispatching。
- `refresh` 依專案序列化，避免兩個同時進行的更新讓舊結果覆蓋新結果。
- Rust：journal 寫入失敗時截掉半行；移除清單項目不再關掉整個程序共用的 store。
- 重新綁定既有成員會把 `reportMode` 重設為 `screen`，直到它再次 hello。
- 已知未處理：原生 `focus` 事件在專案畫面開著時仍會更新 `active`（不會讓終端機取得鍵盤，`native()` 會擋 focus op）；待實機觀察。

## 成員求助（`project help ask|get|answer`）

worker 做到一半想知道「有沒有其他 agent 可以幫忙」時，問 coordinator，而不是問使用者（任務的 `needs-input` 是問使用者，兩者分開）。

- **規則**：`src/projects.ts` 的 `AskHelp`（只有 worker）、`AnswerHelp`（只有 coordinator、每則只能回一次）、`SetHelpDelivery`；狀態是 `state.helps`。求助本身的投遞（到 coordinator）與回覆的投遞（回到提問的 worker）分開記在 `delivery` 與 `answer.delivery`；回覆後求助標為 `replied`，之後晚到的 `sent` 不會退回。
- **指令**：`project help ask`（write、worker，stdin `{text, helpId?}`，`helpId` 兼作 actionId 去重）、`project help answer`（write、coordinator，stdin `{helpId, text}`）、`project help get <helpId>`（唯讀，只有提問者與 coordinator 能讀）。輸入解析在 `src/project-control.ts`，接線在 `src/project-ctl.ts`。
- **結果回送**：coordinator 用 `helpId` 當同意開始的 run（`source:"help-request"`）全部完成或結案後，`helps()` 會再通知求助者一次（`Help.resultDelivery`，`SetHelpDelivery` 的 `part:"result"`，只投遞一次）；求助者用 `help get` 讀 `work` 裡每個任務的狀態與成果。這條不依賴 coordinator 記得轉達。
- **投遞**：`src/project-delivery.ts` 的 `helps()` 與訊息、提問回覆同一條 `exclusive` 佇列，需要「完整」模式且使用者沒在看那個終端機。prompt 只放 helpId 與指令（`helpPrompt`、`helpAnswerPrompt`），內文用 `help get` 讀。重開後停在 `sending` 的標為 `uncertain`，不重送。
- **畫面**：討論區在訊息後列出求助（誰問的、等待或已回覆）與 coordinator 的回覆。
- **驗收**：
  1. 兩個 worker 加入專案並完成 hello；在 worker A 執行 `help ask`，coordinator 終端機收到含 helpId 的通知，討論區出現「A 求助・等待 coordinator 回覆」。
  2. coordinator 用 `help get` 讀到內文、`project get` 看成員清單，`help answer` 回覆；A 的終端機收到通知，`help get` 讀得到答覆，畫面變「已回覆」。
  3b. coordinator 用 `run start {"helpId"}` 派給 B 並驗收完成後，A 的終端機收到「你求助的事已有結果」，`help get` 讀得到 B 的成果。
  3. coordinator 執行 `help ask`、worker 執行 `help answer`、同一則回覆兩次、worker B 讀 A 的求助，都被拒絕。
  4. 使用者正看著 coordinator 終端機時通知不輸入，離開後才送；全域模式不是「完整」時不輸入。

## 自動就緒與模型

- **Coordinator 總是啟用**：主視窗在已存檔頁籤還原完成後（`ready()`），對每個已載入專案、coordinator 終端機沒開時自動啟動並綁定（`ensureCoordinators`，每個專案每次執行只做一次；之後使用者自己關掉會被尊重到下次啟動）。
- **自動打招呼**：delivery 的 pump 每秒對「在線、尚無 handshake」的成員送一次邀請（`greetAll`，agent idle 才送、完整模式才送、每個 instance 成功送出後本次執行不再送、失敗每 5 秒重試）。「請它自我介紹」按鈕仍在，供人工補送。
- **模型**：`Member.model` 是使用者設的預設模型（成員卡的「模型」欄，`SetMemberModel`，只有使用者能改）；計畫步驟可帶 `model`（coordinator 依任務選，`validModel` 嚴格限制字元，因為會被打進終端機）。有效模型 = 步驟的 `model` ?? 成員的 `model`（`modelFor`）。交付前若是 claude 且與上次不同，先送 `/model <名稱>`（尚未寫 journal，agent 忙就稍後重試）；其他 agent 只在任務 prompt 加「建議模型」一行。`project get` 的 `members[].model` 讓 coordinator 看得到。
- **先問再做**：worker 的 intro／任務 prompt／skill 都要求「不知道怎麼做或不確定就用 `project help ask` 問 coordinator，不要猜」。
- **復誦**：worker 的 intro prompt 與 `project hello` 的回覆（`say`）都要求它打完招呼後在終端機唸一遍「遇到不知道怎麼處理的事會先問 HiGhostty Coordinator」（`pledgeInstruction`）。

## 協調通知（notice）與求助 run
- worker 回報 `result`（驗收者不是使用者、也不是自動驗收）、`failed`、`declined` 時，同一筆 journal transaction 會寫入 `NoticeQueued`（id 為 `notice:{taskId}:{attemptId}:{kind}`，重送不會重複）。
- 投遞泵（`project-delivery.ts` 的 `notices`）把待處理通知的 taskId／attemptId 打進 coordinator 終端機，內文用 `project task result` 讀；`delivery` 沿用 queued→sending→sent／uncertain。任務離開通知當時的狀態（驗收、退回、重試…）即 `handled`；已處理或 attempt 已被取代的通知不會再送。
- 求助來源的 `StartRun` 可與主計畫並行（最多 2 個，`MAX_HELP_RUNS`）；一般計畫仍一次一份。`activeRun` 優先回傳主計畫的 run。
- 尚未做：`waiting-help` 狀態、協助 task 掛在原 run 下、notice 的 ack 指令；實機驗收未做。

## 成員小卡
專案頁的成員預設是小卡（名稱、角色、一行狀態與目前步驟），點選才展開用途、模型、連線與操作（`project-panel.ts` 的 `expanded`）。狀態由 `src/project-cards.ts` 的 `memberActivity` 從 journal 推導（等回答／送達不確定／待驗收／工作中，否則顯示連線狀態），測試在 `tests/project-cards.test.mjs`。計畫區改為標題、目標與「已完成 N／M」（`runProgress`），步驟與完成條件收在可展開區（展開狀態以計畫 id 記在 `project-run-view.ts`，重繪不會收回）。討論區預設收合，標題旁顯示新訊息數（含求助），展開後視為已讀（僅本視窗記憶體）。

## 成員啟動設定（獨立工作 session 的前置）
`src/project-launch.ts` 的 `launchSpecFromCommand` 從成員現有的啟動指令推出 `LaunchSpec`（agent 種類、成員原本的 cwd、參數、tmux），並**移除**指向個人主對話的旗標（claude `--resume/-r/--continue/--session-id/--from-pr`、copilot `--resume/--continue`、gemini `--resume`、codex `resume/fork` 子指令），回傳被丟掉的項目供畫面提示。`VAR=` 前綴、別名／wrapper、含 `$()` 等 shell 語法的指令一律回報原因，由使用者明確設定，不猜。目前只有純函式與測試，尚未接到派工流程。

## 工作 session 的身分（execution）
- journal 新增 `Execution`（`RegisterExecution`／`EndExecution`，只有使用者端控制器能下）：一次任務 attempt 對應一個獨立 session，以 instance（tmux session）辨識。登記時核對任務屬於該成員、attempt 是目前這次、這個 instance 沒被綁定或其他 session 占用、同一次 attempt 只有一個 live session。
- `memberForInstance` 也認 live 的 execution，所以工作 session 內的 `ctl` 會對應到該成員；結束後不再有效。
- `project task get`／`task report` 多一道 `executionGuard`：工作 session 只能讀、回報自己的 task 與 attempt，同一成員的其他工作或舊 attempt 會被拒（`forbidden`／`stale_attempt`）。個人終端機不是 execution，行為不變。
- 尚未做：實際開啟工作 session 的派送流程、`HIGHOSTTY_*` 環境變數帶 execution、Rust registry、遷移舊綁定。目前只有資料模型、規則與測試。

## 獨立工作 session（opt-in，**尚未實機驗收**）
worker 成員卡展開後可勾「每個任務用獨立 session 執行」：複製該成員終端機的啟動設定（`launchSpecFromCommand`，失敗會說明原因）存成 `member.launch`（`SetMemberLaunch`）。有 `launch` 的 worker：
- `project-delivery.ts` 的 `handOverIsolated`：每個任務先 `PrepareDispatch`，再用 `host.startWorkSession` 另開背景 tmux 終端機（等 agent ready）、`RegisterExecution`、最後才 `RecordInputStart` 並貼 prompt。輸入開始前失敗＝任務放回佇列並關掉 session；輸入開始後結果不明＝`uncertain`，session 保留。個人終端機不會被輸入，也不做 hello。
- 排程（`verdict`）不看個人終端機的忙碌／觀察／接管，仍受全域 control mode 限制；任務模型以 `--model` 加進新 session 的參數（成員參數已指定模型則不加）。
- 答覆（`replies`）與求助的答覆／結果只送到該任務（或該成員最近一個）live execution 的終端機；沒有就留在佇列。`observedOf` 也改看工作 session，所以卡住偵測對它有效。
- `endFinished`：任務完成／取消／放回佇列或 attempt 被取代時 `EndExecution` 並關閉 session；失敗／拒絕只結束登記、保留終端機供查看；待驗收、等回答、不確定時 session 保留。
- 審查後已修：啟動逾時會關掉已開的終端機；輸入開始後失敗不結束 execution（session 仍能回報）；失敗／拒絕的 session 保留到任務重試或結案才關（先關終端機、成功才 `EndExecution`）；重啟時 `sending` 的 notice 改 `uncertain`；有進行中任務時不能切換獨立 session 設定；浮層「開始」遇到計畫已更新會拒絕；`splitArgs` 遇到 shell 會展開的語法（`$`、反引號、`~`、`{}`、`#`）一律拒絕。
- 仍存在：啟動等待（最長 60 秒）在投遞佇列內，會暫時擋住同專案其他投遞；求助的答覆／結果送到該成員「最近一個」live session，不一定是求助的那個；codex `resume` 只在第一個參數才會被剝除；派送前檢查與實際輸入之間，notice 可能已過期而多送一則（coordinator 照做會得到 invalid_state，無資料損害）。
- 已知缺口：App 重啟後 live execution 若沒有對應終端機不會自動恢復；同 attempt 的修改意見是新 attempt＝新 session（沒有舊對話）；求助 run 與 `waiting-help` 尚未配合；沒有 Rust／環境變數變更（身分靠 tmux session 名稱對應）。

驗收清單（debug 與 release 各一次，**未做**）：
1. 勾選後對該成員派一個任務：另開背景 tmux 頁籤、個人終端機完全沒有輸入；session 內 `ctl project task get/report` 只能操作該任務。
2. 個人終端機忙碌或關閉時仍能派工；成果驗收通過後該 session 的頁籤自動關閉。
3. 任務問使用者問題 → 浮層回答 → 答覆只出現在該工作 session。
4. 派送中途結束 App：重開後任務為 uncertain，不重送。
5. 取消勾選後回到往個人終端機輸入的舊行為。

## 專案自有的終端機（側欄）
專案的 coordinator 與 live 工作 session 列在側欄該專案列底下，不再出現在「未分組」或收藏群組（`project-cards.ts` 的 `ownedTerminals`，以 member／execution id 判斷，不看 `tab.coordinator`）。
- `main.ts` 的 `projectOwned`／`visibleTabs`：側欄、⌘1～⌘9、上一個／下一個頁籤、「關閉其他／右側」都只看可見頁籤，所以編號與畫面一致；專案的終端機從專案列點選（沒開的 coordinator 點選會重新啟動）。
- coordinator 若來自收藏，該收藏列也不再單獨顯示（`member.favoriteId`）。
- 專案載入完成、或擁有關係改變時會重畫側欄；列用簽章比對，只在內容變動時重畫。
- 驗收：開專案後 coordinator 不在未分組、專案列底下有它且點選可切過去；關掉它後點選會重啟；⌘數字對應可見列；開獨立 session 時工作列出現、結束後消失。

## 舊專案升級
不需要遷移程式：coordinator 以成員綁定辨識，重開後若綁定的 tmux 終端機已恢復就直接沿用（`ensureCoordinators` 只在終端機不存在時才啟動），所以不會多開一份，也會自動出現在專案列底下。沒有 `launch` 的舊 worker 維持原本往個人終端機輸入的行為，要改用獨立 session 由成員卡勾選；已送出的舊 attempt 仍綁在原終端機。
