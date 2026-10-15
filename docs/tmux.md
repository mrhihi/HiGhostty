# 頁籤 tmux 背景執行

頁籤設定（編輯頁籤 → 背景執行 → 使用 tmux）啟用後，結束 app 時終端機仍在 tmux 背景執行，下次啟動自動恢復。

## 行為
- 每個窗格（含分割）各自一個 tmux session，名稱 `hg-<8 碼>`（`src/tmux.ts` 的 `newSessionName`）。
- 啟動命令：`tmux new-session -A -s <name> -c <cwd> [命令]`，直接當 surface 的啟動命令（不經互動式 shell，所以不會進 shell history）；tmux 以 `tmux_path` 取得絕對路徑（GUI app 的 PATH 找不到 Homebrew tmux）。detach（⌃B d）後 surface 結束，頁籤關閉並 kill session。`-A` 讓首次啟動與恢復共用同一條命令。
- 命令／shell 結束：Ghostty embedded API 對有 `command` 的 surface 強制 `wait-after-command`，會停在 `[exited]` 等按鍵；所以前端收到 `exited` 事件時對 tmux 窗格直接 `destroy`，不等按鍵。
- 結束 app（主視窗關閉／⌘Q）：先 `save_session` 寫入 `session.json`（`data_dir`），再關閉窗格；`keepTmux` 讓 session 保留。
- 手動關閉頁籤／窗格、或 shell 結束：`forgetSurface` 呼叫 `tmux_kill_session`，避免殘留。
- 啟動時只在主視窗（label `main`）恢復「有啟用 tmux」的頁籤，非 tmux 頁籤行為不變。
- tmux 頁籤的關閉確認不看前景行程（只會是 tmux client）；結束 app（`all-info`）也略過 tmux 窗格（原生 `HGSurface.tmux`，`open` 時由 `tmux` 參數設定），不會跳強制退出。
- 「隱藏 tmux 狀態列」：啟動命令固定附 `\; set-option status on|off`；儲存設定時也會用 `tmux_set_status` 立即套用。
- 收藏只存 `tmux` 旗標，不存 session 名稱，開啟收藏一律新建 session。
- 找不到 tmux 時恢復會提示並略過。
- 啟動命令附 `-e HIGHOSTTY_*=…`（tmux 3.2 起；`control_env` 檢查版本，過舊就不加），讓 pane 裡的程式能用 `highostty ctl`，見 `docs/agent-control.md`。`-A` 接上既有 session 時 tmux 忽略 `-e`。

## 驗收清單（debug 與 release 各一次）
1. 頁籤啟用 tmux 並重新開啟，執行 `sleep 9999`；結束 app，`tmux ls` 仍有 `hg-*`。
2. 重開 app：頁籤、標題、分割版面恢復，輸出仍在。
3. 分割窗格各為獨立 session，皆恢復。
4. 手動關閉 tmux 頁籤後 `tmux ls` 該 session 消失；非 tmux 頁籤行為不變。
5. 勾選「隱藏 tmux 狀態列」儲存，底部綠條立即消失；取消勾選恢復；重啟 app 後維持。
6. 只有 tmux 頁籤時 ⌘Q 不出現強制退出確認。
7. 解除安裝或改名 tmux：啟動顯示提示、不崩潰。

## 啟動命令的路徑解析

tmux 以非互動 shell 執行啟動命令，`~/.zshrc` 加的 PATH（如 `~/.local/bin`）不生效，裸命令（`claude`）會找不到而讓 session 立刻結束。`newSurface` 開 tmux 頁籤前用 `program_path`（登入 shell 查詢）把第一個字換成絕對路徑（`withProgramPath`，`tab.command` 本身不改）；查不到就原樣執行。tmux 頁籤 5 秒內結束會顯示 `app.tmuxExitedEarly` 提示再關閉。
