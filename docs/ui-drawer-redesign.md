# HiGhostty 左側操作區 Drawer 化 UI 改版計劃

> 本文件是交給實作 AI 的完整規格。實作第一步：把本文件複製到 `docs/ui-drawer-redesign.md` 一併進版控。

## 0. Context（為什麼要改）

目前左側 `<aside>`（`src/main.ts:81`）把「工作區樹、群組、收藏、快捷鍵提示」全部擠在一欄 260px，群組用左邊色線 + 縮排表示，按鈕都帶框線，視覺雜亂；頁籤／群組／收藏的編輯分散在 6 個 modal `<dialog>`（rename、tab-command、group-edit、edit、action-menu、config），開 dialog 時原生終端機會被整個隱藏（`suspended: dialogsOpen()`），而且看不出「正在編輯哪個東西、裡面有什麼」。目錄瀏覽器又是另一套從上/下滑出的面板。

改版目標：
1. 左側改成「**Icon Rail + 第一層 Drawer + 第二層 Drawer**」三段式。
2. 有群組（或有子層）的內容，一律在**第二層 drawer** 展開。群組是**收藏的上層**，用來整理收藏；工作區的頁籤依來源收藏的群組分區顯示（見 §6）。
3. 視覺簡約：用**底色深淺**區分層級，不用框線、左色條；唯一的分隔線用在「未分組」與「群組」之間。
4. 頁籤、群組、收藏的編輯改為 **drawer 內的編輯頁**，欄位分區清楚、顯示內容摘要，終端機保持可見。
5. 目錄瀏覽器併入 drawer 體系；header 的按鈕全部移到 rail。

已與使用者確認的決策：
- 目錄面板併入左側 drawer（移除上/下滑出面板與「面板位置」選項）。
- 編輯使用 drawer 內編輯頁；只有「關閉確認」與「命令面板／工作區一覽」仍用 `<dialog>`。
- drawer 展開時**推擠**終端機（終端機變窄，不覆蓋、不暫停）。
- header 只留標題與目前路徑，所有操作移到 rail。

---

## 1. 必須遵守的技術限制（實作前先讀）

1. **原生終端機疊在 WebView 之上**：`bridge.m:752` 以 `addSubview:positioned:NSWindowAbove relativeTo:web` 放置 Ghostty NSView。任何 HTML 元素只要和終端機矩形重疊，就會被終端機蓋住。因此：
   - drawer、下拉選單、popover、toast、拖曳提示都**不可以**畫到 `#terminals` 的範圍內。
   - 所有選單一律「在 drawer 內部展開並推擠下方內容」，不做浮動 popover。
2. **終端機位置由 `updateLayout()` 依 `#terminals.getBoundingClientRect()` 計算**（`src/main.ts:327`）。drawer 只要是 flex 兄弟元素、改變寬度，`ResizeObserver(scheduleLayout)`（`main.ts:1438`）就會自動重排終端機，不需要另外呼叫原生 API。
3. **Header 拖曳**：遵守 `docs/window-drag.md`。header 保持 `data-tauri-drag-region="deep"`、`padding-left: 82px`、標題 `user-select:none`；不可綁 mousedown/startDragging。rail 與 drawer **不是**拖曳區，不要加 drag 屬性。
4. **焦點交還**：任何關閉 drawer、離開編輯頁、執行完操作的流程，結尾都要 `native({ op: "focus", id: active.focused })` 讓鍵盤回到終端機（沿用 `hideDrawer` 動作的模式，`main.ts:1271`）。打開編輯頁時則把焦點放到第一個輸入框。
5. 不動 `bridge.m` 的鍵盤輸入程式（本次改版不需要）。

---

## 2. 整體版面

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ● ● ●   ◈ HiGhostty   ~/Projects/HiGhostty                    (header 44px)│ ← 可拖曳
├────┬──────────────────┬──────────────────┬───────────────────────────────┤
│ ▣  │ 收藏        ＋  ⊞ │ ‹  ● 前端專案  3 ✎│                               │
│    │                  │ [   全部開啟    ] │                               │
│ ★  │ 未分組            │  ▢ api-server  • │        終端機區域               │
│    │  ▢ notes       • │  ▢ web           │        (#terminals)            │
│ ▤  │  ▢ HiGhostty   2 │  ▢ docs        2 │                               │
│    │ ──────────────── │                  │                               │
│    │ 群組              │                  │                               │
│    │  ● 前端專案 3  › │                  │                               │
│    │  ● 維運     1  › │                  │                               │
│ ⚙  │                  │ ＋ 收藏目前頁籤…  │                               │
├────┴──────────────────┴──────────────────┴───────────────────────────────┤
│ 搜尋結果 3                                                    (footer 24px)│
└──────────────────────────────────────────────────────────────────────────┘
  Rail     第一層 Drawer      第二層 Drawer            Workspace
  52px       272px              256px                 flex: 1
```

由左到右四欄，全部是 `<main>` 的 flex 子元素：

| 欄位 | id | 寬度 | 底色 token | 說明 |
|---|---|---|---|---|
| Rail | `#rail` | 固定 52px，永遠顯示 | `--surface-0`（最深） | 圖示入口 |
| 第一層 Drawer | `#drawer-primary` | 開 272px / 關 0 | `--surface-1` | 清單層 |
| 第二層 Drawer | `#drawer-detail` | 開 256px / 關 0 | `--surface-2`（比第一層亮一階） | 子層／預覽／編輯頁 |
| 工作區 | `#workspace` | `flex:1` | 終端機背景 | 原生終端機 |

- 三欄之間**沒有分隔線**；靠底色階梯辨識。
- header 高度由 54px 改為 44px，`main` 高度改為 `calc(100dvh - 44px - 24px)`，footer 24px。
- 視窗寬度 < 760px 時，第二層打開會自動把第一層收成 0（只顯示 rail + 第二層 + 終端機），第二層頂部的「‹」用來回到第一層。

### 2.1 開合動畫

- drawer 以 `width` 過渡：`transition: width 160ms cubic-bezier(.2,.8,.2,1)`；內容區固定寬度（272 / 256px）並 `overflow:hidden`，避免文字在動畫中折行。
- 內容同時做 `opacity 0→1`、`transform: translateX(-8px)→0`（120ms，延遲 40ms）。
- 終端機每一 frame 經 ResizeObserver 重排。**若實測發現 Ghostty 每 frame resize 造成卡頓**，改用退路：寬度瞬間切換（無 width transition），只保留內容的 opacity/translate 動畫。在 `drawer-primary` 的 `transitionend` 再呼叫一次 `scheduleLayout()`（沿用 `main.ts:1440` 的做法）。
- `prefers-reduced-motion: reduce` 時全部無動畫。

---

## 3. 視覺規範（Design Tokens）

在 `src/style.css` 的 `:root` 定義，全檔改用 token，刪除散落的十六進位色碼：

```css
--surface-0: #11151b;   /* header、rail、footer */
--surface-1: #161b23;   /* 第一層 drawer */
--surface-2: #1b212b;   /* 第二層 drawer、編輯頁 */
--surface-input: #0f1319; /* 輸入框底色 */
--hover: rgb(255 255 255 / .05);
--pressed: rgb(255 255 255 / .08);
--selected: rgb(119 223 192 / .13);
--text: #d7e0ef;
--text-muted: #8b97a8;
--text-faint: #5d6878;
--accent: #77dfc0;
--accent-ink: #0d1f1a;   /* 主要按鈕上的文字 */
--danger: #ff8f9a;
--danger-soft: rgb(255 143 154 / .12);
--radius-row: 6px;
--radius-panel: 10px;
--row-h: 30px;
```

規則：
- **不畫框線**：清單列、區段、drawer、群組都沒有 border；移除全域 `button { border: 1px solid … }`。
- 唯一允許的「線」：鍵盤焦點環（`outline: 2px solid var(--accent)`, offset -2px）、拖放插入指示線（2px accent，只在拖曳中出現）。
- 輸入框：無框線、底色 `--surface-input`、高 32px、圓角 6px；focus 時才出現 accent 焦點環。
- 字級：本文 13px；區段標題（caption）11px、`--text-faint`、字距 .04em、粗 600；drawer 標題 14px 粗 600。
- 間距只用 4 / 8 / 12 / 16。drawer 內左右 padding 12px；區段之間 16px。
- 圖示一律用 inline SVG（沿用 `icons` 物件的寫法，`main.ts:69`），線寬 1.6、16px；不要再用 `●○▾▸▰▧⋯` 等文字符號當圖示（狀態點除外，改用 CSS 圓點）。

### 3.1 按鈕種類（只有四種）

| 類別 | class | 外觀 | 用途 |
|---|---|---|---|
| 圖示鈕 | `.icon-btn` | 28×28，透明，hover `--hover`，圓角 6px | 列尾操作、drawer 標題列 |
| 文字鈕 | `.ghost-btn` | 透明、`--text-muted`，hover 底色 | 取消、次要動作 |
| 主要鈕 | `.primary-btn` | `--accent` 底、`--accent-ink` 字，高 32px | 儲存、開啟 |
| 危險鈕 | `.danger-btn` | 透明、`--danger` 字，hover `--danger-soft` | 解散、移除、關閉 |

### 3.2 清單列（共用元件 `.row`）

所有頁籤、群組、收藏、目錄列共用：高 30px、圓角 6px、左右 padding 8px、gap 8px，水平排列：

```
[前置標記 8px] [名稱 flex:1 省略號] [徽章] [hover 才出現的圖示鈕…]
```

- hover：底色 `--hover`；列尾圖示鈕由 `opacity:0` 變 1（鍵盤焦點在列內時也顯示）。
- selected（目前頁籤／目前打開第二層的群組）：底色 `--selected`，名稱 `--text` 粗 500。
- 徽章 `.badge`：11px、`--text-faint`、無底色；分割數顯示為「2」並帶 title「2 個分割」。

---

## 4. Icon Rail（`#rail`）

```
┌────┐
│ ▣  │  工作區   ⌘⇧B（開合最後使用的面板）
│ ★  │  收藏
│ ▤  │  目錄     ⌘O
│    │
│    │  (彈性空白)
│ ⚙  │  設定
└────┘
```

- 每個入口是 36×36 圖示鈕，上下間距 4px，置中；rail 上下 padding 8px。
- `title` 與 `aria-label` 寫中文名稱 + 快捷鍵，例如「目錄（⌘O）」。
- **目前打開的面板**：圖示鈕底色 `--selected`、圖示 `--accent`。沒有左側指示條。
- 行為：
  - 點未打開的入口 → 第一層切換到該面板（若 drawer 關著就打開）；同時關閉第二層。
  - 點目前打開的入口 → 收起整個 drawer（第一、二層都關），焦點回終端機。
- 「工作區」圖示右上角：若有頁籤處於 exited 狀態，顯示 6px `--text-faint` 小圓點（可選，非必要）。
- 「收藏」圖示同時是 OS 拖放的落點：從 Finder 拖目錄到此圖示 → 建立頁籤收藏（見 §10）。

---

## 5. 第一層 Drawer 共通結構

```
┌──────────────────────┐
│ 收藏            ＋  ⊞ │  ← 標題列 44px：標題 + 右側圖示鈕
│                      │
│ 未分組                │  ← caption
│  …列…                │
│ ──────────────────── │  ← 未分組與群組之間的分隔線
│ 群組                  │
│  …列…                │
│                      │  (可捲動)
└──────────────────────┘
```

- 標題列不捲動，內容區 `overflow:auto`，捲軸細（6px、hover 才明顯）。
- 「行內展開區」（取代 action-menu 與 popover）：在標題列下方插入一塊 `--surface-2` 圓角 8px 的區塊，內含 2～4 個整列按鈕，推擠下方清單；按 Esc、再點同一顆鈕、或點區塊外都收合。

---

## 6. 面板：工作區

> **群組模型（修訂）**：群組是**收藏的上層**，不是工作區的分類。工作區不能建立、編輯或指定群組；開著的頁籤屬於哪個群組，完全由它「來自哪個收藏」決定（`tab.favoriteId` → 收藏的 `groupId` → 群組）。不是從收藏開啟、或來源收藏不在任何群組的頁籤，都算未分組。

### 6.1 第一層外觀

```
工作區                         ＋
未分組
  ● HiGhostty         2   ✎  ×
  ○ old-build             ✎  ×      ← exited：空心圈
─────────────────────────────────    ← 分隔線
⌄ ● 前端專案             3            ← 群組＝父列：展開箭頭、色點、名稱（群組色）、頁籤數；點擊收合／展開
  │ • api-server      ★   ✎  ×      ← 子列縮排，左側一條淡淡的群組色導引線；狀態點縮小為 6px
  │ • web             ★   ✎  ×
› ● 維運                 1   •        ← 收合中；• = 目前頁籤在此群組
```

- 標題列只有 `＋`「新增頁籤」（目錄 = 目前終端機 cwd），沒有新增群組按鈕。
- 「未分組」區：caption「未分組」+ 未分組頁籤；沒有時顯示「沒有未分組的頁籤」。
- 若有任何「有群組的頁籤」，在未分組區下方畫一條分隔線（1px、`rgb(255 255 255 / .07)`），之後依收藏面板的群組順序，為**有開著頁籤的群組**各畫一區：
  - **父列**（群組）：展開箭頭（展開時旋轉 90°）、8px 群組色點、名稱（群組色、粗 600）、頁籤數；點擊收合／展開，狀態存 `localStorage("workspace-collapsed-groups")`。收合且目前頁籤在其中時，父列顯示 accent 小點。
  - **子列**（頁籤）：縮排在父列下方（左側 13px + 9px），左側一條 1px、群組色 35% 的導引線表示從屬；列高 28px、狀態點 6px 群組色（exited 為空心圈）；selected 底色 = 群組色 16% 混透明。
  - 透過 ⌘1～⌘0、點擊等方式切換到收合群組內的頁籤時，該群組自動展開。
- 頁籤列：狀態點、名稱、分割數徽章、來源收藏的星號（tooltip「來自收藏「X」」）、hover 時 `✎`／`×`。
  - 單擊切換、雙擊行內改名（Enter／Esc／失焦，輸入法選字中不處理）。
  - `✎` → 第二層「頁籤編輯頁」（§9.1）。
- 順序：未分組在前，接著各群組區（群組順序 = 收藏面板的群組順序），區內依 `tabs` 陣列順序。⌘1～⌘0 照此順序。
- 工作區不使用第二層顯示群組內容。

### 6.2 舊資料相容

舊工作階段快照中的 `groups` 與頁籤 `groupId` 一律忽略（頁籤保留，變成依來源收藏判斷群組）。

---

## 7. 面板：收藏

### 7.1 第一層外觀

```
收藏                        ＋   ⊞
┌ 行內展開區（按 ＋ 後出現）─────┐
│ 收藏目前頁籤「HiGhostty」…     │
│ 從目錄建立收藏…               │
└──────────────────────────────┘
未分組
  ▢ notes                 •   ✎     ← 單擊直接開啟／切換；• = 已開啟
  ▢ HiGhostty         2       ✎
─────────────────────────────────    ← 分隔線
群組
  ● 前端專案        3   •   ›  ✎    ← 單擊開第二層；• = 群組內有已開啟的收藏
  ● 維運            1       ›  ✎
```

- 標題列：`＋` 開行內展開區（「收藏目前頁籤「名稱」…」→ 第二層「收藏頁籤」編輯頁；「從目錄建立收藏…」→ 第二層「新增收藏」）；`⊞`「新增群組」→ 第二層群組編輯頁（新增），存檔後第二層直接顯示該新群組。
- 「未分組」區：沒有 `groupId` 的收藏。完全沒有收藏與群組時顯示空狀態「還沒有收藏。從頁籤編輯頁或上方 ＋ 收藏目前頁籤，或把 Finder 中的資料夾拖到這裡。」；只是沒有未分組收藏時顯示「沒有未分組的收藏。把收藏拖到這裡即可移出群組。」
- 分隔線後 caption「群組」，每個群組一列：色點、名稱、收藏數、已開啟小點、`›`、hover `✎`。沒有群組時顯示「＋ 建立第一個群組」。
- 收藏列：頁籤圖示、名稱（tooltip 含路徑）、分割數徽章、已開啟小點、hover `✎`。**單擊 = 開啟／切換**。
- Finder 拖目錄到收藏面板或 rail 收藏圖示 → 建立未分組收藏。

### 7.2 第二層：群組內容

```
┌────────────────────────┐
│ ‹   ● 前端專案   3   ✎ │
│ [      全部開啟       ] │  ← 主要鈕；群組沒有收藏時不顯示
│  ▢ api-server      •  ✎ │
│  ▢ web                ✎ │
│  ▢ docs           2   ✎ │
│ ＋ 收藏目前頁籤到此群組   │  ← 文字鈕；開「收藏頁籤」編輯頁並預選此群組
└────────────────────────┘
```

- 「全部開啟」：依序處理群組內每個收藏，已開啟的就沿用，沒開的就開啟；最後切換到第一個收藏的頁籤，並關閉第二層、焦點回終端機。
- 收藏列與第一層相同（單擊開啟、`✎` 推入收藏編輯頁）。
- 空群組：「此群組還沒有收藏。把收藏拖到這裡，或按下方按鈕收藏目前頁籤。」
- 整個第二層是落點：收藏拖進來 → 移入此群組；Finder 目錄拖進來 → 建立此群組的收藏。

---

## 8. 面板：目錄

取代原 `#drawer` 上/下面板。⌘O（native `browse` 事件）與空狀態的「開啟目錄」按鈕都打開此面板。

### 8.1 第一層外觀

```
目錄                 [樹|欄]  👁
[↑] [ ~/Projects/HiGhostty      ] [→]
[ 選擇資料夾… ]  [ 在此開啟終端機 ]   ← 文字鈕 + 主要鈕，各半寬

  › 📁 docs                 開啟
  ⌄ 📂 src                  開啟
      › 📁 native           開啟
        ▤ main.ts                 ← 檔案：不可點、--text-faint
  › 📁 tests                開啟
```

- 標題列右側：
  - 分段切換 `[樹|欄]`（兩顆相連的小按鈕，選中者底色 `--selected`），取代 `#layout` select；值存 `localStorage("directory-layout")`。
  - 👁「顯示隱藏檔」切換鈕（開啟時底色 `--selected`），取代 checkbox；值存 `localStorage("show-hidden")`。
- 路徑列：`↑` 上層、路徑輸入框（支援 `~`，Enter = 前往）、`→` 前往。
- 動作列：「選擇資料夾…」（`pick("browser")`）、「在此開啟終端機」（主要鈕，`newSurface(browsePath)`）。
- 樹狀列表（`tree()` 改造）：列高 28px、每層縮排 16px、**移除** `.tree-children` 的左邊線；chevron 旋轉 90° 表示展開；資料夾圖示 `#dfb969`。hover 列尾出現文字鈕「開啟」。單擊資料夾 = 選取（填入路徑列）、雙擊 = 開啟終端機。鍵盤操作沿用現有（↑↓←→、Enter 選取、⌘Enter 開啟）。
- 移除「面板位置（由上而下／由下而上）」選項；`localStorage("directory-edge")` 不再讀取。
- 開新終端機後（`newSurface` 內原本呼叫 `hideDrawer()`）：**關閉整個 drawer** 並焦點回終端機——與舊行為一致。
- 面板開著時跟隨目前終端機 cwd（原本判斷 `$("drawer").classList.contains("visible")` 的四處改成 `directoriesVisible()`，見 §12）。

### 8.2 直欄模式（使用第二層）

- 第一層列表 = `columns` 倒數第二欄（若只有一欄則就是根目錄）；第二層 = 最後一欄。
- 在第一層點資料夾 → 第二層顯示其子目錄；在第二層點資料夾 → 視窗「往右滑一格」：原第二層內容移到第一層，第二層顯示新子目錄。
- 第二層標題列：`‹`（回上一欄，等同 columns 往回一格）、目錄名稱、「在此開啟」主要小鈕。
- 第一層標題下方顯示麵包屑（`~ › Projects › HiGhostty`，11px，可點回任一層）。

---

## 9. 編輯頁（全部在第二層）

### 9.0 共通版型

```
┌──────────────────────────┐
│ ‹ 返回        編輯頁籤     │  ← 標題列：返回(文字鈕) + 頁面標題(置中/靠右皆可，固定一種)
│ HiGhostty                │  ← 對象名稱 16px 粗 600
│ ~/Projects/HiGhostty      │  ← 對象副標 12px --text-muted
│                          │
│ 基本                      │  ← caption
│ 名稱                      │  ← 欄位標籤 12px --text-muted
│ [ HiGhostty            ] │
│ 留空會跟隨目前目錄名稱。     │  ← 說明 11px --text-faint
│                          │
│ …更多區段…                │
│                          │
│ 危險操作                  │
│ [ 關閉頁籤 ]  (危險鈕)     │
├──────────────────────────┤
│        [取消] [ 儲存 ]    │  ← 固定底部動作列（不捲動），底色 --surface-2
└──────────────────────────┘
```

規則：
- 編輯頁在第二層形成**堆疊**：從清單進入 → 「‹ 返回」回到清單；從第一層的 ✎ 直接進入 → 「‹ 返回」關閉第二層。
- 被編輯的對象在第一層／第二層清單中保持 selected 外觀，讓使用者知道正在編輯誰。
- 打開時焦點移到第一個輸入框並全選。
- 鍵盤：Enter（在單行輸入框內）= 儲存；Esc = 取消（等同返回，不保存）；⌘S 不需要。
- 有未儲存變更時，「儲存」按鈕才啟用（未變更時 disabled、opacity .4）；按「返回」或 Esc 直接捨棄，不跳確認（表單很短）。
- 「立即動作」型按鈕（收藏、開啟、關閉、解散）與表單分開放在獨立區段，按下立即執行，**不需要按儲存**；若當下表單有變更，先套用表單再執行（避免收藏到舊名稱）。
- 危險操作一律放最後一區；不會殺程序的危險操作（解散群組、移除收藏）用**兩段式確認**：第一次按下按鈕文字變成「再按一次以確認」並轉為 `--danger-soft` 底色，3 秒內未再按則復原。會殺程序的操作（關閉頁籤、關閉整組）沿用既有 `requestClose` + `confirm` dialog。
- 錯誤（例如路徑無法解析）顯示在對應欄位下方，`--danger` 11px，不用 `notify` toast。

### 9.1 頁籤編輯頁（取代 rename、tab-command dialog 與頁籤 action-menu）

入口：頁籤列 ✎；native `prompt-title` 事件 → 打開此頁並聚焦「名稱」。標題區對象名稱前有群組色點（頁籤屬於某群組時）。

1. **基本**：名稱（`tab.title`，placeholder = 目錄名，「留空會跟隨目前目錄名稱。」）。**沒有群組欄位**——頁籤的群組由收藏決定。
2. **啟動**：啟動命令（等寬字型），說明同前。
3. **內容（唯讀）**：每個分割一列 `分割 N · 主要`／路徑。
4. **收藏**
   - 未連結：「將目前目錄、分割布局與啟動命令存成收藏，可同時放進群組。」+ 主要鈕「收藏此頁籤…」→ 推入「收藏頁籤」編輯頁（§9.3，可選群組）。
   - 已連結：「已連結收藏「X」（群組「Y」／未分組）。編輯頁籤不會自動改動收藏；頁籤的群組由收藏決定。」+「更新收藏」（主要，覆寫快照、保留名稱與群組）、「另存新收藏…」、「編輯收藏…」（要改群組就到這裡）。
5. **危險操作**：「關閉頁籤」。

### 9.2 群組編輯頁（新增／編輯共用）

標題：「新增群組」或「編輯群組」；副標「用來整理收藏」或「N 個收藏」。

1. **基本**：名稱（預設「群組 N」）、顏色（8 色票 + 自訂），說明「從這個群組開啟的頁籤，在工作區會以此顏色標示。」
2. **內容**（僅編輯）：群組內收藏的兩行摘要（名稱／路徑 · 分割數 · 啟動命令）；沒有時「此群組目前沒有收藏」。
3. **開啟**（僅編輯且有收藏）：「全部開啟」。
4. **危險操作**（僅編輯）：「刪除群組」兩段式確認，說明「刪除群組後，裡面的收藏會移到未分組，不會被刪除。」
- 儲存：新增時若是從收藏編輯頁的「＋ 新群組…」進來，返回該頁並自動選中新群組（該頁已輸入的名稱、路徑保留）；從收藏面板 `⊞` 進來則第二層改顯示新群組內容。

### 9.3 收藏編輯頁（編輯／收藏頁籤／從目錄新增 共用）

| 模式 | 進入方式 | 標題 | 目錄欄位 | 內容摘要 |
|---|---|---|---|---|
| 編輯 | 收藏列 ✎、頁籤編輯頁「編輯收藏…」 | 編輯收藏 | 有（只改主要目錄） | 收藏快照 |
| 收藏頁籤 | 頁籤編輯頁「收藏此頁籤…／另存新收藏…」、收藏面板 ＋、群組「＋ 收藏目前頁籤到此群組」 | 收藏頁籤 | 無 | 目前頁籤 |
| 從目錄新增 | 收藏面板 ＋「從目錄建立收藏…」 | 新增收藏 | 有（預設目前 cwd） | — |

1. **基本**：名稱；群組（select：未分組 + 各群組 + 「＋ 新群組…」，預設為收藏目前的群組或入口指定的群組）。選「＋ 新群組…」→ 推入群組編輯頁（新增），回來後選中新群組，已輸入內容保留。
2. **目錄**（編輯／從目錄新增）：路徑 + 「選擇…」，錯誤顯示在欄位下方。
3. **內容（唯讀）**：兩行摘要。
4. **開啟**（僅編輯）：「開啟／切換」、「另開一份」。
5. **危險操作**（僅編輯）：「移除收藏」兩段式確認，「移除收藏不會關閉已開啟的頁籤。」
- 底部按鈕：編輯模式「儲存」，其他模式「收藏」。收藏頁籤模式存檔後，該頁籤連結到新收藏（工作區立即依新收藏的群組重新分區）。新建的收藏列閃一下。

---

## 10. 拖放

| 拖曳物 | 落點 | 結果 | 視覺回饋 |
|---|---|---|---|
| 工作區頁籤列 | **同一區**另一頁籤列上／下半部 | 插到該列之前／之後 | 上緣／下緣 2px accent 線 |
| 工作區頁籤列 | 不同區的列 | 不接受（群組由收藏決定） | 無 |
| 收藏列 | 另一收藏列上／下半部 | 插到該列前／後，並改為該列的群組 | 上緣／下緣 accent 線 |
| 收藏列 | 第一層群組列 | 移入該群組尾端 | 群組列底色 `--hover` |
| 收藏列 | 第一層群組列停留 600ms | 打開該群組第二層 | 同上 |
| 收藏列 | 「未分組」區 | 移出群組 | 區塊底色 `--hover` |
| 收藏列 | 第二層群組內容空白處 | 移入該群組 | 第二層底色 `--hover` |
| 群組列 | 另一群組列 | 排在其前 | 上緣 accent 線 |
| Finder 目錄 | 工作區終端機區 | 開新頁籤 | `.drop-target` |
| Finder 目錄 | 收藏面板 / rail 收藏圖示 | 建立未分組收藏 | 收藏清單底色 `--hover` |
| Finder 目錄 | 開著的第二層群組內容 | 建立該群組的收藏 | 第二層底色 `--hover` |

- 被拖的列 opacity .5；插入線用 inset box-shadow，不改列高。
- 計算「插到某列之後」時，兄弟列要排除被拖的那一列本身。

---

## 11. 面板：設定（取代 config dialog）

```
設定
Ghostty
  版本 1.3.1 · 14pt · 背景透明度 0.95
  ~/.config/ghostty/config          ← 可選取文字，--accent
  [開啟設定檔]  [重新載入]
工作階段
  關閉 app 時記住開啟中的頁籤   (●─)   ← 開關元件（toggle switch），不是 checkbox
診斷
  ┌ 設定載入完成 ──────┐            ← --surface-input 底、等寬 11px、最高 200px 捲動
快捷鍵
  ⌘1～⌘0   切換頁籤
  ⌘⇧B      開合側欄
  ⌘O       目錄
  ⌘T       新頁籤
  ⌘D / ⌘⇧D 分割
```

- 快捷鍵區取代舊 `aside .hint`，兩欄對齊（鍵 `--text-muted` 等寬，說明 `--text`）。
- 打開設定面板時呼叫 `native({ op: "config" })` 刷新（沿用 `settings` 動作）。

---

## 12. 狀態模型與程式改動

### 12.1 新狀態（`src/main.ts`）

```ts
type Panel = "workspace" | "favorites" | "directories" | "settings";
type Detail =
  | { kind: "group"; groupId: string }            // 收藏群組內容（收藏面板）
  | { kind: "dir-column"; path: string }
  | { kind: "edit-tab"; tabId: string; focus?: "name" }
  | { kind: "edit-group"; groupId?: string }
  | { kind: "edit-favorite"; favoriteId?: string; groupId?: string; tabId?: string };
let panel: Panel | null = null;           // null = drawer 收起
let lastPanel: Panel = "workspace";
let detailStack: Detail[] = [];           // 第二層堆疊，空 = 第二層關閉
```

建議把**純狀態轉移**寫成無 DOM 的函式放在新檔 `src/drawer.ts`，方便測試：
- `togglePanel(state, p)`、`closeAll(state)`、`pushDetail(state, d)`、`popDetail(state)`、`replaceDetail(state, d)`、`onGroupRemoved(state, groupId)`（第二層正顯示被刪群組時清空）。

收藏資料：`workspace-favorites-v2.json` 的 `items` 同時存放群組 `{ id, kind: "folder", name, color }` 與頁籤收藏 `{ id, kind: "tab", name, tab, groupId? }`（Rust 端不需改動）。讀取時用 `src/model.ts` 的 `migrateFavorites` 拆成 `folders`／`favorites`，舊的 `kind: "group"` 快照會被拆成群組與各頁籤收藏並寫回。

渲染拆成：`renderRail()`、`renderPrimary()`（依 panel 分派到 `renderWorkspacePanel/renderFavoritesPanel/renderDirectoriesPanel/renderSettingsPanel`）、`renderDetail()`。現有 `renderTabs()` 與 `renderFavorites()` 改為呼叫上述對應渲染（保留函式名稱當入口，因為很多地方呼叫它們）。編輯頁的表單在重繪時不可被清掉：`renderDetail()` 若目前頂層是編輯頁且 DOM 已存在同一對象，則只更新唯讀區段，不重建輸入框。

### 12.2 DOM（`root.innerHTML`，`main.ts:78`）

```html
<header data-tauri-drag-region="deep"><b>◈ HiGhostty</b><span id="current">…</span></header>
<main>
  <nav id="rail" aria-label="側欄">
    <button id="rail-workspace" class="rail-btn">…svg…</button>
    <button id="rail-favorites" class="rail-btn">…</button>
    <button id="rail-directories" class="rail-btn">…</button>
    <span class="rail-spacer"></span>
    <button id="rail-settings" class="rail-btn">…</button>
  </nav>
  <section id="drawer-primary" aria-label="側欄面板"><div class="drawer-inner"></div></section>
  <section id="drawer-detail" aria-label="詳細內容"><div class="drawer-inner"></div></section>
  <section id="workspace"><div id="terminals" aria-label="原生 Ghostty 工作區"></div><div id="empty" hidden>…</div></section>
</main>
<footer><span id="search-status"></span></footer>
<!-- 保留：confirm、palette dialog；#search；#notice -->
```

- 移除：`<aside>`、舊 `#drawer`（目錄面板）、dialog `edit`、`config`、`rename`、`tab-command`、`group-edit`、`action-menu`，以及對應的 `action(...)` 綁定（`main.ts:1265–1372` 一帶）。邏輯函式（`saveGroupEditor`、`saveTabFavorite`、`saveGroupFavorite`、`closeGroup`、`removeFavorite`、`openFavorite`、`pick`、`persistFavorites`、`dissolveGroup` 等）**保留並重用**，只改它們讀取輸入值的來源（改由編輯頁傳參數，不再讀 dialog 的 input id）。
- `id="tabs"` 與 `id="favorites"` 保留在對應面板的清單容器上（拖放判斷與 `role="tree"` 用）。
- `<main>` 不再需要 `aside { order:-1 }`。

### 12.3 需替換的既有判斷

- `$("drawer").classList.contains("visible")`（`activate`、`handleEvent` 的 focus/cwd、Esc 監聽）→ `directoriesVisible()`（`panel === "directories"`）。
- `browse()` → `openPanel("directories")` 後 `followDirectory(...)`，焦點到路徑輸入框。
- `hideDrawer()` → `closeAll()` + `scheduleLayout()`。
- `toggle-sidebar` 事件與 rail 再點 → `panel ? closeAll() : openPanel(lastPanel)`。
- `snapshot().collapsedSidebar` 保持欄位名，意義 = `panel === null`；還原時 `collapsedSidebar` false → 打開 `lastPanel`（`localStorage("drawer-panel")`，預設 workspace）。
- Esc 監聽（`main.ts:1424`）：只在 WebView 有焦點且無 dialog 時：有第二層 → `popDetail`；否則有第一層 → `closeAll` 並交還終端機焦點。
- `prompt-title` 事件 → `pushDetail({kind:"edit-tab", tabId: active.id, focus:"name"})`（並確保 panel 為 workspace）。
- `showActionMenu`、`showTabMenu`、`showFavoriteMenu`、`editGroup`、`createGroup`、`editFavorite`、`edit`、`renameTab`、`editTabCommand` 改為推入對應編輯頁。
- `newSurface` 結尾的 `hideDrawer()`：只在 `panel === "directories"` 時關閉 drawer；從工作區面板按 ＋ 新增時 drawer 保持開啟。

### 12.4 CSS（`src/style.css`）

重寫為：tokens → 基礎元素（button reset、input）→ header/footer → rail → drawer 共通（`.drawer-inner`、標題列、caption、`.row`、`.badge`、四種按鈕、行內展開區、segmented、toggle switch、color swatches）→ 各面板特有 → 編輯頁（`.form-section`、`.field`、`.help`、`.field-error`、`.sticky-actions`）→ 拖放狀態 → dialog（confirm/palette 調整為新 token、無框線、圓角 12px）→ reduced motion。刪除 `.tree-group` 左邊線、`.favorite` 左色條、`.tree-children` 邊線、`.column` 右邊線、`.drawer-tools` 底線、`#drawer.top` 等不再使用的規則。

### 12.5 文件

- `README.md`「目錄與工作區」段落更新：rail + 兩層 drawer、目錄面板改在左側、移除上/下位置設定、編輯頁說明。
- `docs/window-drag.md` 驗收清單第 5 條改為「header 內沒有按鈕；rail 按鈕不會拖動視窗」。
- `docs/workspace-navigation-checklist.md` 新增「Drawer 改版」區段（內容 = 下方 §13）。

---

## 13. 驗收

### 自動
- `npm test`：新增 `tests/drawer.test.mjs` 測 `src/drawer.ts` 的狀態轉移（切換面板關第二層、再點收起、pop 到空關第二層、刪除群組時清掉對應 detail）；`tests/favorites.test.mjs` 測舊群組收藏的拆分。既有 `tests/*.test.mjs` 須全過。
- `npm run build`（tsc + vite）無錯。

### 實機（`CARGO_TARGET_DIR=/private/tmp/highostty-target npm run tauri -- dev`，debug 與 release 各一次）
- [ ] rail 四個入口切換正確；再點目前入口收起；⌘⇧B 開合並記住上次面板；重啟後側欄開合狀態還原。
- [ ] drawer 開合時終端機寬度跟著變，無殘影、無被 HTML 蓋住或蓋住 HTML 的情況；動畫順暢（不順就套用 §2.1 退路）。
- [ ] 工作區：未分組區、分隔線、依群組色分區；收藏面板點群組 → 第二層列出收藏與「全部開啟」；再點收起；窄視窗（<760px）時第一層自動讓位。
- [ ] 頁籤：單擊切換、雙擊行內改名（Enter／Esc／失焦）、✎ 編輯頁各欄位儲存正確、× 關閉有執行中程序時跳確認。
- [ ] 群組：新增（含收藏編輯頁選「＋ 新群組…」來回流程）、改名、色票與自訂色、刪除兩段式確認（收藏移回未分組）、全部開啟。
- [ ] 收藏：＋ 行內選單顯示正確對象名；單擊開啟／切換；收藏頁籤時可選群組；更新收藏 vs 另存新收藏；移除收藏不關閉實例；舊群組收藏拆分只發生一次；多視窗同步後清單即時更新。
- [ ] 目錄：⌘O 打開並聚焦路徑；樹狀與直欄（第二層滑動）模式；顯示隱藏檔；選擇資料夾；在此開啟終端機後 drawer 收起、焦點回終端機；`cd` 後面板跟隨。
- [ ] 拖放：表 §10 每一列都測一次；Finder 拖到收藏面板與 rail 收藏圖示。
- [ ] 鍵盤：Esc 先退第二層再收第一層；編輯頁 Enter 儲存、Esc 取消；離開 drawer 後打字直接進終端機（含中文輸入法，照 `docs/keyboard-input.md` 抽測）。
- [ ] `docs/window-drag.md` 驗收清單全數重跑（header 只剩標題與路徑）。
- [ ] ⌘1～⌘0 順序與第一層畫面順序一致（未分組 → 各群組）。

## 14. 建議實作順序

1. 複製本文件到 `docs/ui-drawer-redesign.md`。
2. 新增 `src/drawer.ts` + 測試。
3. CSS tokens 與基礎元件（按鈕、row、輸入框），先不改結構。
4. 改 DOM 骨架（rail + 兩層 drawer），把舊 aside 內容搬進工作區面板，確認終端機推擠與焦點正常。
5. 工作區面板（依收藏群組分區）+ 行內改名 + 拖放。
6. 編輯頁：頁籤 → 群組 → 收藏；刪除對應 dialog。
7. 收藏面板 + 預覽。
8. 目錄面板（樹 → 直欄），刪除舊 `#drawer`。
9. 設定面板，刪除 config dialog。
10. 文件更新、實機驗收。
