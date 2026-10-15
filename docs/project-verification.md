# 專案區實機驗收（P7）

規格 §15 的案例對應到實機操作；`npm test`／`cargo test` 不涵蓋。每項在 debug 與 release 各做一次，未完成項逐條記錄在最下面。細節與前置見 `docs/projects.md`（各節的編號清單）；本文是總表。

前置：HiGhostty 控制模式「完整」；至少兩個 tmux 頁籤各以 `claude`／`codex`／`copilot`／`gemini` 啟動；`tmux` 3.2 以上；專案資料夾放在非同步目錄。

| # | 規格案例 | 操作 | 必須看到 |
| --- | --- | --- | --- |
| 1 | Mail → Jira | coordinator 提交兩步計畫（收信→建單，建單標 `externalWrite`，上游不設自動驗收）；開始；A 交成果；coordinator 驗收；B 交 Jira 單號 | B 的 `task get` 輸入是 A 成果的固定版本；單號可追；沒改任何成員的工具設定 |
| 2 | 同一 worker 兩專案 | 兩個專案都綁同一個 tmux 頁籤，各開 run | 只有一個專案的任務在進行，另一個顯示「正在做另一個專案的工作」；完成後才輪到另一個 |
| 3 | 人工操作 | 接單前切進該成員的終端機 | 任務不交付，頂端顯示暫停；離開後它閒置 10 秒才自動恢復；「交回專案」立即恢復 |
| 4 | 同頁籤兩分割 | A、B 都跑 agent，派 A | 只有 A 收到文字（候選只列第一個窗格，B 不會被選） |
| 5 | worker 權限詢問 | 接單後 worker 停在核准畫面 | 頂端「需要你處理」；專案沒有按任何鍵；你處理後提示消失 |
| 6 | 貼上後 crash | 在輸入進行中強制結束 App | 重開後任務是 uncertain；沒有自動 Enter、沒有重複 prompt；可選「沒收到／正在做／失敗」 |
| 7 | 回覆遺失 | 送出後（模擬）丟掉回覆 | 保留 uncertain；worker 之後送出符合的 result 可直接到 result-ready |
| 8 | 重複回報 | 對同一 reportId 送兩次 | 一份事件；內容不同的第二次回 `report_conflict` |
| 9 | 舊 attempt 回報 | 重試後讓舊 attempt 才回結果 | 保存為過期；不覆寫新 attempt；下游不開跑 |
| 10 | 兩視窗同時開始 | 兩個視窗對同一專案按「開始」 | 只有一個 run；另一邊顯示錯誤 |
| 11 | 持有終端機的視窗被關 | 關掉成員所在視窗 | 該成員顯示離線；任務不被重送；重開後成員（tmux）仍綁定 |
| 12 | 畫面追蹤 worker | 成員以 `screen` 模式，coordinator 用 `task observed` | 標「由畫面整理」；確認前不進 result-ready；下游不自動開始 |
| 13 | readonly | 控制模式改「唯讀」 | 專案可看；自動交付停用（任務卡寫原因）；`hello`／`report` 回 `forbidden`；沒有自己切回完整 |
| 14 | 儲存失敗 | 專案資料夾設唯讀或把 journal 弄壞 | 沒有輸入；畫面顯示唯讀原因；中段損毀指出行號 |
| 15 | 回報需核准 | worker 執行 report 指令時進 blocked | 頂端提示；專案不按鍵；hello 的 `reportNeedsApproval` 顯示在卡片 |
| 16 | 核准被拒、無回報 | 拒絕 worker 的核准，它回到 idle | 任務維持原狀；10 分鐘後出現沉默提示；不判成功或失敗 |
| 17 | 答覆投遞給 worker | worker 回 `needs-input`，在畫面回答 | prompt 只含 ID；worker 用 `task get` 的 `replies` 讀答案；舊 attempt 的答覆不會被輸入 |
| 18 | 退回重做 | result-ready 後退回並填意見 | 新 attempt；舊成果保留；意見出現在 `task get` 的 `rework` |
| 19 | 人工暫停遺忘 | 看完終端機沒交回 | 離開並 idle 10 秒自動解除；頂端暫停數消失 |
| 20 | 現在交付 | worker 忙碌時按「現在交付」 | 仍先寫 `InputWillStart`；blocked 或沒有 agent 的畫面按鈕不出現／被拒 |
| 21 | 畫面追蹤成果 | 見 #12 | 同上 |
| 22 | 授權畫面 | worker 卡在終端授權 | 見 #5；任務狀態不變；離開 blocked 後提示消失 |
| 23 | task get 限權 | 非該任務成員呼叫 `task get` | `forbidden`，不洩漏其他成員的輸入 |
| 24 | 快速切換 | 專案／終端機連點、關 Drawer | 原生視圖不遮首頁；焦點在可見內容；中文組字不送進隱藏的 shell |
| 25 | 自動驗收 | 中間步驟設 `acceptance: auto-on-protocol-result` | 成員用協定回報 result 後直接完成並開下一步；放在 `externalWrite` 步驟之前會被 `invalid_plan` 拒絕 |
| 26 | 結案 | 有失敗的任務時按「結案」 | 保存未完成清單；之後可對新版本計畫重新開始 |

## 協作改版（v2）新增項目

對應 `docs/project-collaboration-v2-plan.md`；各項的詳細操作在 `docs/projects.md`、`docs/attention.md`。

| # | 案例 | 操作 | 必須看到 |
| --- | --- | --- | --- |
| 27 | 全域待辦卡片 | 在別的專案或終端機工作時，讓專案產生提問、待驗收、計畫待開始 | 鈴鐺數字加一；浮層最上方有專案卡片，可直接回答／通過／退回／開始；已被處理的問題卡片消失 |
| 28 | 已讀與稍後 | 對卡片按「忽略」「稍後」，開另一個視窗 | 徽章與提示列兩個視窗一致；卡片仍在清單；稍後 30 分鐘後恢復；來源解決才消失 |
| 29 | 單行提示 | 有未看過的專案待辦、浮層關著 | 終端機上方一行（最優先一項＋另有 N 項），`stty size` 列數減少；「處理」開浮層、× 收起；與檔案面板、預覽窗、⌘⇧P、拖曳標題列並用正常 |
| 30 | 成員小卡 | 開專案頁 | 成員為小卡，點選才展開；等回答／待驗收／等待協助顯示在卡上；計畫只顯示摘要與進度；討論區預設收合並顯示新訊息數 |
| 31 | 獨立工作 session | worker 勾「每個任務用獨立 session」後派任務 | 另開背景 tmux 頁籤；個人終端機沒有任何輸入；session 內 `ctl` 只能操作該任務；完成後頁籤自動關閉；失敗的保留 |
| 32 | 側欄專案子列 | 開專案、跑獨立 session | coordinator 與工作 session 在專案列底下、不在未分組；⌘數字對應可見列；沒開的 coordinator 點選會重啟；重開 App 不閃現在未分組 |
| 33 | coordinator 通知 | worker 交 result／failed／declined | coordinator 終端機收到只含 ID 的提示並自行驗收；coordinator 忙或在等核准時排隊不丟；已處理的不再送 |
| 34 | 求助與等待 | 工作 session 發 `help ask`，coordinator 派 B 協助 | 任務顯示「等待協助」、不報沉默；B 完成後答覆只回原 session，任務回到進行中；主 run 沒被擋 |
| 35 | 選單原地回答 | 背景頁籤的 agent 跳出單選選單 | 卡片有選項按鈕，點選後終端機選到該項並確認；點之前移動游標則不按任何鍵並提示；畫面上別處有編號清單、核取方塊、密碼／登入時沒有按鈕 |
| 36 | 遺失的 session | 殺掉工作 session 的 tmux | 120 秒後 execution 結束；任務保留並由沉默提示或手動核對處理，不自動重做 |

## 未完成或未實測的項目

（驗收時逐條記錄。）

- 2026-10-16：協作改版 #27–#35 由使用者回報「都驗完了」；逐項的 debug／release 結果沒有留下書面紀錄。#36（遺失 session 的 120 秒收尾）是之後才加的，尚未驗。
- 原計畫與實作的刻意差異：求助的協助工作是並行的另一個 run（上限 2），沒有掛在原 run 下，也沒有規格快照與依賴循環檢查；沒有 Rust 端 execution registry 與 controller 單一化（身分靠 tmux session 名稱，由使用者端控制器登記）；App 退出期間不調度。
- 原有項目（#1–#26）以下仍未實測：

- S0 沒涵蓋：真正的拒絕情境、接近 20,000 字元的長資料、Codex 預設權限、全新 context 的 A 版。
- 沉默逾時 10 分鐘（`DEFAULT_STALL_MS`）與人工暫停解除的 10 秒（`RELEASE_QUIET_MS`）都沒有實測依據。
