# 窗格 git 資訊列

每個分割窗格底部有一條 20px 的資訊列，顯示該窗格目前目錄的 git 狀態：`⎇ 分支  ✓` 或 `⎇ 分支  ● 有變更的檔案數  ↑ahead ↓behind`。沒有遠端追蹤分支時顯示「無遠端追蹤」。不在 git repo 內的窗格不保留空間。

## 架構

- 狀態查詢：`src-tauri/src/git.rs`（`git_status`）執行 `git -C <path> status --porcelain=v2 --branch -uno`，`GIT_OPTIONAL_LOCKS=0` 避免搶 index lock；參數以陣列傳入，不經 shell。解析函式 `parse_status` 有 `cargo test`。
- 純邏輯：`src/git.ts`（列文字、保留高度、比較）；測試在 `tests/git.test.mjs`。
- DOM 與刷新：`src/main.ts` 的 `refreshGit`、`gitStrip`。資訊列是 `.surface-outline` 的子元素（`pointer-events:none`）。
- 版面：`updateLayout()` 送給原生的矩形底部縮短 20px，終端機不被資訊列蓋住；不用 `overlay-cutout`。只移除 `.surface-outline`，不對 `#terminals` 呼叫 `replaceChildren`。

## linked worktree 標示

- 獨立命令 `git_worktree` 跑 `git rev-parse --show-toplevel --git-dir --git-common-dir`（較慢，所以不併進 `git_status`：徽章先出現，worktree 資訊稍後補上，每個目錄 60 秒才重查一次），兩者 canonicalize 後不同即回傳 `{ root, main }`（`linked_worktree`，有 `cargo test`；`main` 是 common dir 的上層，即主工作樹）。
- 頁籤／收藏列的 git 徽章前面多一個 `icons.worktree` 圖示（`.wt-icon`，12px，用獨立色票 `--worktree`，不跟 git 狀態顏色）；窗格資訊列不加圖示。
- 徽章 tooltip 用 `src/tooltip.ts` 的 `data-tip`（無延遲，`#tooltip` 是 `position:fixed`、`pointer-events:none`），不用原生 `title`；tooltip 內容是摘要＋ worktree 目錄＋主儲存庫路徑（`gitTip`）。

## 刷新時機

- `cwd` 事件與 `focus` 事件（有 1 秒快取）。
- `updateLayout()` 時每個窗格（1 秒快取，拖分隔線時不會每幀呼叫 git）。
- 每 5 秒輪詢可見窗格（4 秒快取），抓到外部 commit、checkout、修改。
- 不使用檔案 watch（同 `docs/preview.md` 的理由）。
- 只有「是否在 repo 內」改變時才重排版面；狀態內容改變只更新該窗格的資訊列文字。

## 注意

- 窗格被關閉時 `forgetSurface` 會清掉 `gitInfo`、`gitFetchedAt`。
- 非聚焦窗格的 cwd 依賴 shell integration（Ghostty 預設啟用）；未啟用時只在聚焦時更新。
- 目前只有底部資訊列；尚未提供設定開關。

## 驗收清單（`npm test` 與 `cargo test` 不涵蓋）

1. 分割兩個窗格，分別 `cd` 到不同 repo 與非 repo 目錄：repo 窗格底部顯示正確分支，非 repo 窗格沒有空白列，終端機高度正確（`stty size`）。
2. 在 repo 內 `git checkout -b x`、`git commit`、修改檔案，5 秒內資訊列更新。
3. 拖分隔線、⌘D 分割、zoom、切換頁籤、開關預覽窗後，資訊列位置與終端機大小正常。
4. 關閉窗格後不殘留資訊列；detached HEAD 顯示本地化的「分離的 HEAD」。
5. 英文與繁中切換時 tooltip 文字正確。
6. `git worktree add ../wt-x`：主 repo 頁籤無圖示、`wt-x` 頁籤有圖示；滑過徽章 tooltip 立即出現、不被側欄裁切，移開即消失；`git worktree remove` 後圖示消失。
