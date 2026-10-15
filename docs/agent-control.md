# agent 控制指令（`highostty ctl`）

終端機裡的程式（尤其是 coding agent）可以用 `highostty ctl <指令>` 呼叫 HiGhostty。已有基礎建設、唯讀指令與背景執行／送輸入指令（見下方「指令」）；多 agent 協作見下方。

## 架構
1. 每個終端機 surface 開啟時由 `native` 注入環境變數（`src-tauri/src/control.rs` 的 `surface_env`，經 `bridge.m` `open` op 的 `env_vars`）：
   - `HIGHOSTTY_ENV=1`、`HIGHOSTTY_SURFACE_ID`、`HIGHOSTTY_SOCKET`（socket 路徑）、`HIGHOSTTY_CLI`（本 app 執行檔）
   - 模式為「關閉」時也照樣注入，之後改成開啟，已開的終端機立刻可用。
2. `HIGHOSTTY_CLI ctl <字詞…>`：同一支執行檔，`main()` 一開始偵測 `ctl` 就連上 socket、印出一行 JSON、結束，不啟動 GUI。CLI 不解析指令，只把 argv 原樣送出。exit code：0 成功、1 指令失敗、2 連不上 app。
3. Rust 伺服器（`control.rs`，獨立 thread）收到請求後對所有視窗 emit `control-request {reqId, mode, caller, argv}`。**每個視窗都回覆一次**（`control_reply`），並宣告 `claim`：
   - `owner`：這件事是我的，附上回覆。Rust 收到就立刻回應（`caller` 範圍＝擁有呼叫者終端機的視窗；`surface` 範圍＝擁有指定終端機的視窗）。
   - `part`：跨視窗列表（`all` 範圍）中我這一份。Rust 合併成 `{windows:[{window, …}]}`（`main` 排第一）；第一份到達後其他視窗再給 1.5 秒，還在載入、沒有監聽器的視窗不會拖住結果。
   - `none`：與我無關。全部視窗都回 `none` 時立刻回 `not_found`，不必等逾時。
   
   等待上限是 `--timeout <ms>`（預設 30 秒）加 5 秒緩衝。指令的 `scope`（`caller`／`surface`／`all`）定義在 `control.ts` 的 `OPS`，`claimFor` 決定 claim。
4. 指令名稱、參數、權限、回覆格式等純邏輯全在 `src/control.ts`（`OPS` 表）並由 `tests/control.test.mjs` 涵蓋；`main.ts` 的 `handleControl`／`runControl` 只負責接線與執行。新增指令：在 `OPS` 加一筆（`write` 標明是否會改動狀態或送輸入），在 `runControl` 加對應 case，補測試。

## 指令（視窗範圍見 `scope`；寫入類需要「完整」模式）
所有指令都回一行 JSON：`{"ok":true,"result":…}` 或 `{"ok":false,"error":{"code","message"}}`。`highostty ctl help` 列出完整用法。

| 指令 | 範圍 | 說明 |
|---|---|---|
| `ping`、`whoami`、`help` | caller | 測試、呼叫者所在的視窗／頁籤／終端機、指令清單 |
| `window list` | all | 各視窗：是否在前景、頁籤數、使用中頁籤 |
| `tab list [--here]` | all | 各視窗的頁籤與終端機（id、cwd、title、exited、tmux、是否為呼叫者）；`--here` 只列呼叫者所在的視窗 |
| `agent list [--here]` | all | 偵測到 agent 的終端機與狀態 `blocked`／`working`／`idle`（`agentState`） |
| `surface read <id> [--lines N] [--scrollback]` | surface | 讀畫面；`--scrollback` 含捲動緩衝（原生端最多回傳尾端 2 MB），`--lines` 取最後 N 行（上限 5000） |
| `surface wait <id> (--match 字串…\|--regex 式) [--lines N] [--timeout ms]` | surface | 輪詢到輸出出現；檢查含捲動緩衝的最後 N 行（預設 200），已存在的輸出也算命中 |
| `agent wait <id> [--until idle\|blocked\|working] [--timeout ms]` | surface | 輪詢到狀態達成；預設 idle 或 blocked；該終端機沒有 agent 回 `not_found` |


「唯讀」的意思是：不開頁籤、不送輸入、不改持久資料、不搶焦點、不開別的 App。因此下面這些屬於唯讀模式也可用：

| 指令 | 範圍 | 說明 |
|---|---|---|
| `alert raise --title T [--body B] [--option O…]` | caller | 對使用者發出待處理提示：出現在待處理面板（問題＝body，選項＝各個 `--option`）與頁籤列的標籤，頁籤變色、鈴鐺加一。來源 `agent` 的優先度高於偵測到的提示與響鈴（`signal` < `prompt` < `agent`），所以不會被畫面偵測覆蓋，也不會因畫面改變而消失；使用者切到該頁籤、聚焦視窗或按「忽略」才清除。使用者正在看這個終端機時回 `raised:false`。標題單行 80 字、說明 2000 字、選項最多 12 個 |
| `preview open <path> [--side right\|bottom]`、`preview close`、`preview status` | caller | 在呼叫者所在頁籤開／關／查詢預覽窗（見 `docs/preview.md`）。只改畫面配置、狀態只存在記憶體，不搶焦點，所以屬唯讀；相對路徑以呼叫者的目錄為準，目錄與二進位以外的檔案都可開 |
| `alert clear` | caller | 清除自己發出的提示（問題解決後用） |
| `tab status <text>` \| `--clear` | caller | 在頁籤列顯示一行短狀態（最多 40 字），只存在記憶體，不進工作階段；用於「跑測試 3/5」這類進度 |

寫入類（`write: true`，唯讀模式回 `forbidden`）：

| 指令 | 範圍 | 說明 |
|---|---|---|
| `tab new [--cwd 路徑] [--tmux] [--focus] [-- 命令…]` | caller | 在呼叫者所在的視窗開新頁籤，**預設在背景**（不切過去、不搶焦點；空工作區例外），`--focus` 才切過去。回傳 `{tab, surface, window, background}`。給命令時在 shell 裡執行（頁籤保留）；`--tmux` 時命令改為 tmux 的啟動命令，命令結束頁籤就關閉 |
| `surface run <id> -- 命令…` | surface | 在終端機的 shell 提示字元送出一行並按 Enter。shell 不在提示字元（有前景程式、已結束）回 `busy`，不送任何輸入。`--` 後只有一個字詞時視為完整命令列（`-- "npm run dev && echo up"`），多個字詞時各自加引號（argv 語意）；不可含換行、上限 8000 字元 |
| `surface key <id> <key>` | surface | 送出一個按鍵：enter、tab、esc、backspace、up、down、left、right、ctrl+a 到 ctrl+z |

| `files reveal <path…>` | caller | 在 Finder 顯示（Finder 會被帶到前景）。路徑可用 `~`、相對路徑（以呼叫者的目錄為準），每個都必須存在，一次最多 50 個；走現有的 `files-reveal` op |
| `files quicklook <path…>` | caller | 用 Quick Look 預覽給使用者看，走現有的 `files-quicklook` op；會取得呼叫者所在視窗的鍵盤焦點，使用者按空白鍵或 Esc 關閉。終端機顯示不了圖片、PDF 時特別有用 |
| `preview window <path>` | caller | 把檔案開在獨立的預覽視窗（自動更新、同一個檔案只開一個、不搶焦點）；會多出一個視窗，所以需要完整模式。詳見 `docs/preview.md` |
| `snippet add --name N --text T [--scope global\|cwd\|絕對目錄] [--keyword K…]` | caller | 新增指令片段到 ⌘⇧P 面板。預設 scope 是呼叫者目前的目錄；同名、同 scope、同內容已存在時不重複新增（`created:false`）。**不提供 `--run`**：agent 新增的片段不會自動執行，由使用者在面板選取、確認後才送進終端機 |

| `agent start <kind> [--cwd 路徑] [--focus] [--timeout ms] [-- 參數…]` | caller | 在新頁籤（預設背景）啟動 agent（claude、codex、gemini、opencode、copilot、aider，名稱即執行檔），參數各自加引號。等到偵測到 agent、畫面兩次輪詢不變且為 idle 或 blocked 才回傳 `{surface, tab, window, agent, state, ready}`（`ready` 為 state 是否 idle；卡在「信任此資料夾？」這類詢問時 `state:"blocked"`、`ready:false`）。逾時（預設 30 秒）回 `timeout`，但頁籤已開啟，訊息含 surface id |
| `agent prompt <id> <text> [--wait] [--timeout ms]` | surface | 對終端機裡的 agent 送出 prompt 並按 Enter（貼上＋真正的 Enter；多行 prompt 靠 bracketed paste 不會提早送出）。**目標是 blocked 時回 `agent_blocked`，什麼都不送**；沒有偵測到 agent 回 `not_found`；不能對自己所在的終端機送。`--wait`：先要看到 working 或 blocked（5 秒內沒有回 `agent_prompt_stalled`），再等狀態穩定（連兩次輪詢）為 idle 或 blocked；逾時回 `timeout`。逾時與 stalled 都**不代表沒送出**，不要重送 |
| `agent keys <id> <key…>` | surface | 對 agent 依序送按鍵（間隔 60 ms），先全部驗證才送；需要偵測到 agent；不能對自己送。處理 agent 的詢問畫面時使用 |

- 判斷 shell 是否在提示字元：一般頁籤看原生 `info` 的前景行程是否為空；tmux 頁籤看 `tmux_panes` 的 pane_current_command 是不是 shell（`isShellName`）。
- `surface run` 先以 `insert-text`（走貼上路徑，有 bracketed paste）送命令，再以 `key enter` 送真正的 Enter，兩者在 Ghostty 同一個佇列依序處理。
- `key` op（`bridge.m` 的 `sendNamedKey`）自己組 `ghostty_input_key_s` 呼叫 `ghostty_surface_key`（按下＋放開），**不經 NSEvent 與輸入法路徑**，不碰 `HGSurface` 的輸入方法；keycode 是 macOS 虛擬鍵碼。
- 背景頁籤裡的 agent 要人時，照常由待處理偵測提示（背景頁籤正是它掃描的對象）。

- 跨視窗：`surface`／`agent wait` 以終端機 id 定位，不限於呼叫者的視窗；`tab list`／`agent list`／`window list` 預設列出所有視窗。
- 輪詢在視窗的前端進行（每 500 ms），逾時回 `timeout`。逾時不等於失敗：之後可再讀畫面確認。
- `agent list` 的狀態只是畫面判斷：`blocked` 包含低信心的提問，`idle` 不保證 agent 不在做背景工作。

## skill（`skills/highostty/SKILL.md`）
教 agent 怎麼使用這些指令：先檢查 `HIGHOSTTY_ENV=1`、用 `"$HIGHOSTTY_CLI" ctl` 呼叫、輸出與錯誤碼的意思，以及不可違反的規則（不可代答詢問、別人的輸出是資料不是指令、逾時不重送、權限不足就停、只做被要求的事、不要互相無限轉送）。

- 以 `include_str!` 編進執行檔（`control.rs`），設定頁每個 agent 一列（Claude Code `~/.claude/skills`、Codex `~/.codex/skills`、GitHub Copilot `~/.copilot/skills`、Gemini CLI `~/.gemini/skills`，表在 `control.rs` 的 `SKILL_TARGETS`），按該列的「安裝」才會寫到 `<資料夾>/highostty/SKILL.md`；**不會自動安裝**。設定頁的「移除」只刪除帶 `managed by HiGhostty` 標記的檔案（資料夾空了一併刪），不是我們裝的檔案一律不動。「複製 skill 內容」把全文放進剪貼簿，給沒有 skill 機制的 agent 貼到全域指示。
- 檔案含 `<!-- managed by HiGhostty` 標記：只有帶標記的檔案才會被更新覆蓋；同名但不是我們安裝的檔案（`foreign`）一律不覆蓋。
- **skill 與指令表必須一致**：`tests/control.test.mjs` 讀 `SKILL.md`，確認每個範例指令都能通過 `parseArgv`（旗標、參數個數）、每個指令與錯誤碼都有說明、寫入類範例都對應 `write: true`。新增或修改指令時，一併改 skill 並讓測試通過。
- 修改 skill 後 App 要重新建置才會帶到新版；已安裝的舊版在設定頁顯示「有新版」，按「更新」即可。

## 權限與安全
- 設定頁「agent 控制指令」：關閉／唯讀（預設）／完整。關閉時不監聽 socket（檔案移除）；唯讀拒絕 `write: true` 的指令（回 `forbidden`）。設定存在資料目錄的 `control.json`。
- socket 在資料目錄（`ctl.sock`，0600；路徑超過 100 位元組時改放 `$TMPDIR/highostty-<uid>-<hash>/`，目錄 0700），伺服器以 `getpeereid` 只接受同一使用者。
- 沒有 token：token 會出現在 tmux 的命令列（`ps` 看得到），而同使用者的程式本來就能讀資料目錄，token 擋不住任何人；實際的限制是模式設定。
- 另一個 HiGhostty 執行個體已佔用 socket 時，本執行個體不會搶，設定頁切換時會顯示錯誤。

## tmux 頁籤
- tmux 的 pane 不會繼承 tmux client 的環境，所以 `tmuxCommand` 對新建的 session 加 `-e`（tmux 3.2 起；`control_env` 檢查版本，過舊就不注入）。pane 內有 `HIGHOSTTY_ENV`、`HIGHOSTTY_SOCKET`、`HIGHOSTTY_CLI`、`HIGHOSTTY_TMUX_SESSION`，沒有 `HIGHOSTTY_SURFACE_ID`（每次啟動都會變）。
- CLI 把 `HIGHOSTTY_TMUX_SESSION` 當 `tmuxSession` 送出，`resolveCaller` 找出承載該 session 的 surface，所以 app 重啟、恢復 session 之後仍可用。
- `-A` 接上既有 session 時 tmux 會忽略 `-e`；舊 session 保有建立當時的值（路徑改變時需重建 session）。

## 驗收清單（debug 與 release 各一次）
1. 新開頁籤：`env | grep HIGHOSTTY` 有 `HIGHOSTTY_ENV`、`HIGHOSTTY_SURFACE_ID`、`HIGHOSTTY_SOCKET`、`HIGHOSTTY_CLI`。
2. `"$HIGHOSTTY_CLI" ctl ping` → `{"ok":true,"result":{"pong":true,"mode":"readonly"}}`，exit 0；`ctl whoami` 的 `surface` 與 `HIGHOSTTY_SURFACE_ID` 相同、`cwd` 正確；`ctl help` 列出指令；`ctl nope` 回 `unknown_op`、exit 1。
3. 分割窗格與第二個視窗各跑一次 `ctl whoami`，回報的 surface／window 正確。
3a. 開兩個視窗各數個頁籤：`ctl window list` 列出兩個視窗；`ctl tab list` 兩個視窗都在、呼叫者標 `caller:true`；`--here` 只剩自己的視窗。
3b. 在視窗 A 對視窗 B 的終端機（用 `tab list` 取得 id）跑 `ctl surface read <id> --lines 20`，內容正確；`ctl surface read 不存在的id` 立刻回 `not_found`（不是等逾時）。
3c. `ctl surface wait <id> --match ready --timeout 5000`：另一個視窗的終端機 `sleep 2; echo ready` 後命中；沒有輸出時 5 秒回 `timeout`。
3d. 在視窗 B 的終端機跑 claude／codex，`ctl agent list` 看得到它與狀態；`ctl agent wait <id> --until blocked` 在出現權限詢問時返回。
4. 設定改「關閉」→ `ls <資料目錄>/ctl.sock` 不存在、`ctl ping` exit 2；改回「唯讀」或「完整」→ 已開著的終端機立即可用，不必重開。
5. tmux 頁籤：`env | grep HIGHOSTTY` 有 `HIGHOSTTY_TMUX_SESSION`，`ctl whoami` 成功；結束 app 重開（session 恢復）後 `ctl whoami` 仍成功。
6. 兩個 HiGhostty 同時執行（不同 `HIGHOSTTY_DATA_DIR`）互不干擾；同一資料目錄的第二個執行個體切換設定時顯示「另一個 HiGhostty 正在使用控制 socket」。
7. 在 app 外的終端機執行 `HIGHOSTTY_CLI ctl ping`（沒有 `HIGHOSTTY_SOCKET`）→ exit 2，訊息說明不在 HiGhostty 內。
8. `ctl ping --timeout 300`、`ctl ping --bogus`（`bad_args`）行為正確。
9. 寫入類（設定為「完整」）：`ctl tab new -- "sleep 30; echo ready"` 回傳 `background:true`，目前頁籤與焦點不變、頁籤列多一個頁籤；切過去看到命令正在執行。`--focus` 會切過去；`--tmux` 的頁籤也能開。
10. `ctl surface run <id> -- "echo hi"`：對 shell 閒置的終端機，命令出現並執行；對正在跑 `sleep 30` 的終端機回 `busy` 且沒有任何輸入。再對 tmux 頁籤各試一次。含引號的命令（`-- echo "a b"`）與 `-- "a && b"` 的行為符合上表。
11. `ctl surface key <id> ctrl+c` 中斷 `sleep 30`；`esc`、`up`、`enter` 在 vim／shell 裡正確；`ctl surface key <id> f5` 回 `bad_args`。
12. 模式改回「唯讀」後，第 9～11 項回 `forbidden`，不會有任何動作。
13. **輸入路徑迴歸**（因為新增了 `key` op）：照 `docs/keyboard-input.md` 的驗收清單跑一遍，debug 與 release 都要；跑完 `~/Library/Logs/DiagnosticReports` 沒有新的 `highostty-*.ips`。
14. 唯讀模式下：背景頁籤跑 `ctl alert raise --title 要你決定 --body "用 A 還是 B？" --option A --option B`，頁籤變色、鈴鐺 +1，待處理面板的卡片顯示問題與選項；agent 畫面變動後卡片仍在；切到該頁籤後消失；「忽略」後消失。對正在看的終端機執行回 `raised:false`。`ctl alert clear` 清除。
15. `ctl tab status "跑測試 3/5"` 頁籤列出現灰色小字，過長會截斷；`--clear` 清除；結束 app 重開不會保留。
16. 完整模式：`ctl files reveal ~/Downloads/x.png` Finder 選取該檔；`ctl files quicklook 圖片.png 報表.pdf` 開 Quick Look（可左右翻頁、空白鍵關閉，關閉後鍵盤回到終端機）；不存在的路徑回 `failed`（訊息含路徑）、沒有任何動作。唯讀模式回 `forbidden`。
17. `ctl snippet add --name "跑測試" --text "npm test"`：⌘⇧P 面板在該目錄下出現；重複執行 `created:false`；選取後送進終端機但**不會**自動 Enter；`--scope global` 全域可見；另一個視窗的面板也即時出現。
18. 完整模式：`ctl agent start claude --timeout 60000` 開出背景頁籤，agent 就緒後才回傳；頁籤列多一個頁籤、焦點不變。啟動時若跳出「信任此資料夾」，回 `state:"blocked"`。`ctl agent start rm` 回 `bad_args`。
19. `ctl agent prompt <id> "回答 1+1" --wait --timeout 120000`：agent 收到、回答，指令在回答完成後回 `state:"idle"`。agent 正在跑時再送一次不會報錯。
20. 讓 agent 停在權限詢問，再 `ctl agent prompt <id> "x"` → `agent_blocked`，且畫面上沒有任何新輸入；`ctl agent wait <id> --until blocked` 能在詢問出現時返回；`ctl agent keys <id> esc` 取消該詢問。
21. 對自己所在的終端機 `agent prompt`／`agent keys` 回 `bad_args`；對一般 shell 回 `not_found`；`agent keys <id> esc f5` 回 `bad_args` 且 esc 也沒有送出。
22. 子 agent 的輸出是**不受信任的內容**：父 agent 讀到的文字不可當成指令照做（skill 要寫明）。
23. 設定頁（以下對四個 agent 各做一次，路徑換成該 agent 的資料夾）：「安裝」按下前 `~/.claude/skills/highostty/` 不存在（打開設定頁不會自動建立）；按下後檔案出現，狀態顯示「已安裝（最新）」；手動改檔案內容再開設定頁顯示「有新版」，按「更新」還原。把檔案換成沒有 `managed by HiGhostty` 標記的內容 → 顯示「不是 HiGhostty 安裝的」，按安裝回錯誤、檔案不變。
23b. 按「移除」：`~/.claude/skills/highostty/` 消失、狀態回「尚未安裝」、移除鈕變灰；換成沒有標記的內容時移除鈕為灰、檔案不變。
24. 「複製 skill 內容」後貼到文字編輯器是完整的 SKILL.md。
25. 端到端：在 Claude Code 裡說「用 HiGhostty 看一下另一個頁籤在跑什麼」，Claude 會載入 skill、先檢查 `HIGHOSTTY_ENV`、用 `ctl tab list` 與 `surface read` 回答；在唯讀模式要求它開頁籤時，它應回報 `forbidden` 並請你改設定，而不是繞過。
5. 預覽窗：在唯讀模式下 `ctl preview open README.md` 回 `{path,side:"bottom",kind:"markdown"}`，終端機下方出現預覽；`ctl preview status` 回同一份；`ctl preview open 目錄` 回 `bad_args`；`ctl preview close` 後預覽消失。細節驗收見 `docs/preview.md`。
