# 檔案面板

每個頁籤各有一個檔案面板，用來查看並操作終端機所在目錄，操作方式比照 Finder。它取代了原本左側 Rail 的「目錄」面板（`docs/ui-drawer-redesign.md` §8）。

## 版面與狀態

```
┌rail┬─────────────────────────────────────────────┐
│    │  ┌ ↑ ~ › proj › src  ⟲ 👁 ⤢ ^ ─────────────┐ │
│ ▣  │  │ 名稱 ▲            大小     修改日期        │ │  ← #files（浮層）
│ ★  │  │ › 📁 native        —       今天          │ │
│    │  └──────────── ═ #files-resizer ───────────┘ │
│    │   終端機（整面仍可點、可拖入）                    │
└────┴─────────────────────────────────────────────┘
```

- `#files` 是 `#workspace` 內的絕對定位浮層，從頂部落下（`width:80%`，視窗／終端機區改變寬度時跟著變，最小 360px；`z-index:29`，比待處理／⌘⇧P 低，它們可疊在上面）。**不佔空間、不擠窄終端機。**
  - 原生終端機 NSView 疊在 WebView 之上，所以靠 `overlay-cutout`（`slot:"files"`）把浮層範圍挖洞顯示；`reportCutout` 在開關、ResizeObserver（含寬度隨工作區變動）、切頁籤時送出，關閉時一定送全零（收合時帶 `restoreFocus`）。
  - 原生端 `cutoutRequests[label][slot]`：不同 slot 的洞可同時存在（palette／attention／usage 共用 `default`，與檔案浮層互不影響）。重疊的洞會先切成不相交的矩形再做 even-odd 遮罩。
- **Esc、`^`（`#files-close`）、右上資料夾鈕、⌘O（焦點已在列表時）會收合；失去焦點（點終端機、切換視窗／App）不收**，讓它可留著當參考或一邊拖曳。獨立視窗內 Esc 只清除選取。
  - Esc 與側欄收合不衝突：`main.ts` 的 window 層 Esc 處理在焦點不在側欄（`#rail`／`#drawer-*`）時先呼叫 `filesPanel.collapse()`，面板開著就只收面板；焦點在側欄內才由側欄處理。
- 高度存在 `localStorage("files-height")`（預設工作區 50%，`clampDropHeight`：160px～工作區 85%），所有頁籤共用，拖曳浮層底緣的 `#files-resizer` 調整。
- 已沒有「滿版」（浮層蓋住終端機沒有意義；要大畫面請彈出成視窗）。`restoreFiles` 會忽略舊存檔的 `full`。
- 面板寬度 < 420px 時（container query），只留名稱欄。
- 每個頁籤的狀態存在 `tab.files`（`FilesState`，見 `src/files.ts`）：`open`、`path`、`follow`、`expanded`。
  - `SavedTab.files`（`SavedFiles`，`saveFiles`／`restoreFiles` 在 `src/files.ts`）存 `open`、`path`、`follow`、`expanded`、`columnRoot`、`view`：重開時面板維持開合、瀏覽位置、展開的資料夾、直欄最左欄與清單／直欄檢視。`restoreFiles` 會丟掉格式不對的欄位；`expanded` 只保留在 `path` 底下的項目。若 `follow` 為真而重開後終端機 cwd 與存的 `path` 不同，`onCwd` 照舊跟隨 cwd 並清空展開。
    - `files-panel.ts` 的 `update`（含 `openPanel`，不可再直接指定 `tab.files`）發現存檔欄位改變就呼叫 host 的 `visibilityChanged`；`main.ts` 的 `rememberFilesState` 立即排程 tmux session 存檔，收藏則 600ms 去抖後 `persistFavorites`。非收藏、非 tmux 的頁籤本來就不會跨啟動還原。
- `updateLayout()` 一開始呼叫 `filesPanel.sync()`。所有切換頁籤的路徑（點擊、⌘數字、關閉頁籤、還原收藏）都經過這裡，所以不用在每個呼叫點各自同步。

## 檢視模式

標題列的分段按鈕切換「清單」與「直欄」（舊稱「三欄」）。每個頁籤各記自己的檢視（`tab.files.view`，隨上面的狀態存檔還原）；`localStorage("files-view")` 只是「最後一次選擇」，給沒選過的頁籤當預設。切換頁籤時 `sync()` 套用該頁籤的檢視。沒有快捷鍵，因為 ⌘1～⌘9 已用於切換頁籤。

- **清單**：樹狀列表，有名稱、大小、修改日期三欄，點欄頭排序，資料夾可就地展開。
- **直欄**：上方是 Finder 式的一排欄位，每往下一層就多一欄，下方是橫跨全寬的預覽區，類似 ranger／yazi。`#files-body` 是水平 flex 捲動容器，欄位超出可視範圍時可左右捲動；`#files-split` 把它與預覽區上下排列。
  - **欄位鏈**：`[祖先欄…] [目前欄] [資料夾內容欄]`。最左欄的資料夾存在 `tab.files.columnRoot`（只在記憶體，純函式 `columnRootFor`／`columnChain` 在 `src/files.ts`）。
    - 起點是進入點的上層（上層｜目前｜內容）；→ 進入資料夾時 root 不變，往右多一欄；← 回上層只少一欄，退到最左欄之外時 root 跟著上移，往左補一欄。
    - 路徑跳到 root 以外（cd 跟隨、麵包屑）會重設為新路徑的上層。
    - 導航或選取後 `revealColumns()` 自動橫向捲動，讓目前欄左緣與內容欄右緣可見。
  - **欄寬**：每欄右緣有 `.col-resizer`，拖曳調寬，雙擊恢復預設 200px（範圍 120～800px）。寬度**依該欄列出的資料夾路徑**記在 `localStorage("files-column-widths")`（`{路徑: px}`），所有頁籤共用；預設寬度不存，最多 300 筆，超過刪最舊的（`rememberColumnWidth`）。
    - 清理：`load()` 讀取目錄失敗就刪該路徑與其底下的紀錄；讀到目錄內容時，刪掉不在清單裡的子資料夾紀錄（`pruneColumnWidths`）。沒顯示隱藏檔時保留點開頭的資料夾，避免誤刪。只會清到瀏覽過的路徑。
  - 預覽區高度可拖曳 `#files-preview-resizer` 調整，存 `localStorage("files-preview-height")`，所有頁籤共用，範圍 80px～面板高 70%（`clampPreviewHeight`）。
  - **祖先欄**（`.col-ancestor`，動態產生）：列出該層目錄，通往目前目錄的那一列反白。點資料夾會進入該資料夾，點檔案會回到該層並選取它。
  - **目前欄**（`#files-list`）：和清單模式是同一個元素，選取、鍵盤、右鍵選單、改名、剪貼簿、拖入全部共用。直欄模式不就地展開資料夾，新增資料夾／檔案一律建在目前目錄。
  - **資料夾內容欄**（`.col-child`）與**底部預覽區**（`.col-preview`）：選取後 120ms 更新。
    - 單選資料夾 → 內容欄唯讀列出內容，點其中一列會進入並選取該項；預覽區顯示名稱、種類、項目數、修改日期。
    - 單選檔案 → 內容欄留空；預覽區上方是縮圖（盡量放大），下方是名稱、種類、大小、修改日期。
    - 在內容欄點檔案 → 該檔案在內容欄反白、不移動欄位，預覽區顯示它；點資料夾仍會進入。
    - 多選 → 預覽區顯示「已選取 N 個項目」。
  - **側欄右鍵**：祖先欄與內容欄的項目也有右鍵選單，只對按到的那一項操作，不改變目前欄的選取。在空白處按右鍵 → 對該欄列出的資料夾開背景選單。
    - 重新命名，以及在別的資料夾新增項目時，會先移到該資料夾並選取該項，再就地改名，因為改名只能在目前欄進行。
    - 在內容欄的檔案上按右鍵，會像單擊一樣把它反白。
  - **縮圖**：`hg_files` 的 `preview` op 在背景執行緒用 `QLThumbnailGenerator` 產生，最長邊 256pt @2x，最多等 3 秒。失敗時改用 `NSWorkspace iconForFile:`，種類取自 `UTType.localizedDescription`。
    - 回傳 PNG data URL，CSP 已允許 `img-src data:`。
    - 前端以「路徑＋修改時間」快取 64 筆。

## 跟隨 cwd

- `follow` 為真時，面板路徑跟著聚焦終端機的 cwd 走。來源是 `cwd` 事件，以及同頁籤內切換分割時的 `focus` 事件。
- 在面板中進入其他目錄（雙擊、麵包屑、⌘↑）會暫停跟隨，標題列出現「回到終端機目前目錄」。瀏覽回 cwd 也會自動恢復跟隨。
- 外部變更偵測：
  - 面板開著時，每 2 秒用 `dir_stamp` 讀根目錄與已展開目錄的 mtime，有變化就重新讀取。
  - 視窗重新取得焦點時也會重新讀取。
  - 目錄 mtime 只反映項目增刪與改名；檔案內容變動造成的大小／日期變化，要等下次重新讀取才更新。

## 操作

| 操作 | 方式 |
|---|---|
| 選取 | 單擊；⌘ 切換（資料夾）；⇧ 範圍；↑↓（⇧ 延伸）；⌘A。⌘+單擊檔案＝在預覽窗開啟（自動更新） |
| 展開／收合（清單） | 點三角形；→／← |
| 進入／回上層（直欄） | → 進入選中的資料夾並選第一項；← 或 ⌘↑ 回上層並選回原資料夾 |
| 開啟 | 雙擊或 ⌘↓。資料夾會進入該資料夾，檔案用預設 App 開啟 |
| 上層 | ⌘↑、標題列 ↑（兩種模式都會選回原資料夾） |
| Quick Look | 空白鍵（再按一次或 Esc 關閉）。單選時在 Quick Look 中按 ↑↓ 會移動列表選取；多選時由 Quick Look 自己翻頁 |
| 重新命名 | Enter 或選單。預設選取主檔名；Enter 確定、Esc 取消、失焦確定；輸入法選字中不處理 |
| 拷貝／剪下／貼上 | ⌘C／⌘X／⌘V；在資料夾上按右鍵可「貼到此資料夾」 |
| 複製一份 | ⌘D |
| 丟到垃圾桶 | ⌘⌫ |
| 新增資料夾 | ⇧⌘N（新增後直接進入改名） |
| 收合 | Esc、標題列 `^`、右上資料夾鈕；⌘O／⌘0 在焦點已在列表時也會收合 |
| 焦點回終端機 | Esc：收合面板並回到終端機（獨立視窗內只清除選取） |
| 右上角資料夾按鈕 | 標題列最右側的 `#files-toggle`，單純開關目前頁籤的面板；面板開著時按鈕呈選取狀態，沒有頁籤時停用 |
| ⌘O（字母 O）或 ⌘0 | 面板沒開 → 開啟並聚焦；開著但焦點在終端機 → 聚焦列表；焦點已在列表 → 關閉 |

**右鍵選單**用 `@tauri-apps/api/menu` 的 `Menu.popup()` 產生原生 NSMenu，貼近終端機也不會被遮住。
- 一律經 `src/context-menu.ts` 的 `popupMenu`（邏輯在 `src/native-menu.ts`），不要直接呼叫 `Menu.new`／`popup`／`close`。
  - 原因：Tauri 的 popup 在選單開著的整段期間持有 webview resources table 的鎖，主執行緒則在選單的 tracking loop 裡繼續處理網頁 IPC。這時任何要拿這把鎖的 IPC（`Menu.new`、`close`）都會讓主執行緒永遠卡住，整個 App 凍結。
  - 所以選單開著時忽略新的右鍵；舊選單在下一次 popup 開頭才 close，不用計時器。
- 項目上：打開、打開方式（預設 App 列第一）、在終端機中編輯、Quick Look、在新頁籤開啟終端機、插入路徑到終端機、拷貝路徑、剪下／拷貝／貼上／複製一份／重新命名、新增資料夾／檔案、在 Finder 中顯示、丟到垃圾桶。
- 空白處：新增資料夾、新增檔案、貼上、在新頁籤開啟終端機、在 Finder 中打開、重新整理。

**在終端機中編輯**：在目前頁籤向右分割，執行 `sh -c '${EDITOR:-vi} "$1"' sh '<path>'`。
- 用 `commandInShell` 先載入使用者 shell，讓 rc 裡設定的 `EDITOR` 生效。
- 透過 `sh -c` 包一層，zsh、bash、fish 都能執行。
- 編輯器結束後保留 shell。

**Finder 拖入**：拖到面板會複製進游標下的資料夾，否則複製進面板目前的資料夾。拖到終端機是貼上路徑。

**拖出到終端機**：在列上按住拖動超過 5px，前端送 `files-drag`（`files.m` 的 `beginDrag`，主執行緒）開原生 drag session（WKWebView 自己的 HTML5 drag 不會帶 file URL）。拖的是目前選取項目（按到的列不在選取內就只拖該列；上層欄／內容欄的列只拖自己）。
- 終端機 `HGSurface` 已註冊 file-URL，`performDragOperation` 貼出**反斜線跳脫**的路徑（多個以空格分隔，不送 Enter）；Finder、其他視窗的終端機、獨立視窗拖到主視窗終端機都適用。
- 跳脫規則 `shellEscape`（`src/files.ts`，有測試）／`HGEscapePath`（`files.m`，兩邊要同步）：保留 `A-Za-z0-9_@%+=:,./~-` 與非 ASCII，其餘字元前加 `\`；含換行等控制字元時整段用 `$'…'`。
- 拖進面板自己的資料夾列走既有 Finder 拖入流程（複製）。

## 剪貼簿

- 「拷貝」寫入每個項目的 `public.file-url`，Finder 可以貼上。第一個 item 另外寫入反斜線跳脫的路徑文字（`HGEscapePath`），貼到終端機時和拖放檔案的效果一致。
- 「剪下」另外寫入自訂型別 `com.highostty.cut`（內容為路徑清單）。
  - 貼上時只有標記和目前的檔案清單完全相符，才當作搬移。從 Finder 或其他 App 拷貝的檔案一律當作複製。
  - 標記放在系統剪貼簿上，所以跨視窗也能用。
  - 搬移完成後，剪貼簿改寫為新位置的一般拷貝。
- 「拷貝路徑」只寫入純文字路徑，一行一個。

## 檔案操作與命名規則

會改動檔案的操作全部在 `src-tauri/native/files.m` 的 `hg_files`。它由 Rust `file_op` 在 `spawn_blocking` 中呼叫，不卡 UI，也不可碰 AppKit UI。

- 拷貝／搬移：NSFileManager `copyItemAtPath`／`moveItemAtPath`，保留 metadata，在 APFS 上會用 clone。
- 不可把資料夾放進它自己；在同一資料夾內搬移視為不動。
- 同名處理（Finder 慣例）：
  - 目的地已有同名 → `名稱 2.ext`、`名稱 3.ext`…
  - 在同一資料夾複製 → `名稱 副本.ext`，再衝突則 `名稱 副本 2.ext`。
  - 點開頭的檔案（`.env`）視為沒有副檔名。
- 重新命名：名稱不可空白、不可含 `/`；目標已存在就報錯。只改大小寫的改名可以執行。
- 刪除：一律 `trashItemAtURL` 丟到垃圾桶，不提供永久刪除。
- 部分成功時，面板底部列出失敗項目，不跳 toast。

`hg_files` 也負責兩個唯讀查詢，避免慢速磁碟或 LaunchServices 造成彩球：`preview`（縮圖）與 `open-with-apps`（「打開方式」清單，只用 NSWorkspace 的 URL 查詢，不碰 UI）。同理，輪詢用的 `dir_stamp` 也是 async command，不在主執行緒 `stat`。

AppKit 相關的操作走 `hg_command` 的 `files-*` op（主執行緒）：`files-pasteboard-write`、`files-pasteboard-read`、`files-pasteboard-text`、`files-open`（可指定 App）、`files-reveal`、`files-quicklook`／`-update`／`-close`。另外兩個 op 在 `bridge.m`：
- `insert-text`：把文字送進終端機，不送 Enter。
- `focus-web`：讓 WebView 成為 first responder；⌘O 聚焦列表時需要它。

**Quick Look**：QLPreviewPanel 從 key window 的 first responder 往上尋找 controller。
- WKWebView 本身就實作了 `acceptsPreviewPanelControl:`（WebKit 內建預覽用）。若讓 WebView 當 first responder，panel 會在那一層停下、用 WebKit 的空資料來源，預覽視窗就是空的（早期版本的 bug）。
- 因此 `files-quicklook` 會先把隱形的 `HGQuickLookResponder` view 設為 first responder（記住原本的 responder），再開啟 panel，由它把 `HGQuickLook` 設為 dataSource。
- panel 關閉或失去控制時，`endPreviewPanelControl:` 還原原本的 first responder。若控制權被別人拿走（例如點回網頁），會順便關掉 panel，避免顯示空白。面板關閉時送出 `quicklook-closed` 事件；單選時面板內的 ↑↓ 轉成 `quicklook-key` 事件交給列表。

## 驗收

自動：`npm test`（`tests/files.test.mjs` 涵蓋狀態、選取、排序、路徑引號、`shellEscape`、浮層高度）、`npm run build`、`cargo check`／`cargo test`。

實機（`CARGO_TARGET_DIR=/private/tmp/highostty-target npm run tauri -- dev`，debug 與 release 各一次）：

- [ ] ⌘O 與 ⌘0 都能開啟、聚焦、關閉；每個頁籤各自記住開合；切換頁籤時面板跟著換；從收藏還原時保留開合。
- [ ] 浮層從頂部落下、終端機寬度不變；浮層不被終端機蓋住且可點，浮層以外的終端機可點、可打字；Esc、`^`、資料夾鈕會收合，點終端機、切換視窗／App 不會收；收合後焦點回終端機且整面可點。
- [ ] 拖曳底緣調高並記住；開著檔案浮層時開待處理鈴鐺、⌘⇧P、用量浮層，都能疊在上面，關掉後檔案浮層與遮罩仍正確。
- [ ] 拖單檔、多選、含空白／括號／`'`／中文／`$` 的檔名到終端機：貼出反斜線跳脫的路徑，在 zsh／bash 以 `ls` 貼上內容可執行；直欄模式、獨立視窗拖到主視窗終端機也行；拖到 Finder 為複製；Finder 拖進終端機同樣是反斜線跳脫。
- [ ] `cd` 後面板跟隨；同頁籤切換分割時跟隨該分割；面板瀏覽別處後暫停跟隨，按「回到終端機目前目錄」恢復。
- [ ] 面板拷貝 → Finder 貼上，以及反向；剪下＋貼上會搬移；同名自動改名；在同一資料夾 ⌘D 產生「副本」；拷貝路徑。
- [ ] 改名與新增資料夾（含中文輸入法選字中按 Enter 不會提前送出）；⌘⌫ 丟到垃圾桶，可從垃圾桶還原。
- [ ] 空白鍵開 Quick Look，預覽視窗有內容（圖片、PDF、程式碼）；↑↓ 切換預覽；再按空白鍵或 Esc 關閉後，鍵盤回到檔案列表；多選時 Quick Look 可翻頁。
- [ ] 清單／直欄切換後模式會記住；各祖先欄、目前欄、內容欄、預覽欄內容正確。
- [ ] 直欄連續 → 進入多層，每層多一欄並自動捲到右側；← 退回，退到最左欄之外時往左補一欄；cd 到不相關目錄會重設為「上層｜目前｜內容」起點。
- [ ] 拖曳欄間分隔線可調寬、雙擊恢復預設；重啟後回到同一資料夾，該欄寬度保留；窄面板（約 360px）可左右捲動。
- [ ] 拖曳預覽區上方分隔線可調高度，重啟後保留；拉到上下限不破版。
- [ ] 直欄下 ←→ 進出資料夾，回上層時選回原資料夾；點上層欄、預覽欄的項目會跳過去，鍵盤仍在目前欄。
- [ ] 預覽欄：圖片、PDF 顯示縮圖；沒有縮圖的檔案顯示系統圖示與種類；多選顯示數量。
- [ ] 直欄模式下的右鍵、剪下貼上、改名、新增資料夾、Finder 拖入都正常；窄面板（約 360px）仍可用。
- [ ] 上層欄／內容欄的項目與空白處按右鍵都有選單；拷貝、貼到此資料夾、改名（會先跳到該層）、丟到垃圾桶、新增資料夾都正常，目前欄的選取不變。
- [ ] 外接碟或慢速磁碟上開著面板、反覆在少見類型的檔案上按右鍵，不會出現彩球。
- [ ] 打開方式子選單列出 App 並標出預設；雙擊檔案用預設 App 開啟；「在終端機中編輯」在右側分割開啟 `$EDITOR`，結束後保留 shell。
- [ ] 右鍵選單是原生選單，在面板靠終端機那一側按右鍵也不會被遮住。
- [ ] 選了選單項目或按 Esc 後 5 秒內再按右鍵、快速連按右鍵，檔案面板與頁籤列都不會卡死。
- [ ] Finder 拖到面板空白處／資料夾列會複製進對應資料夾；拖到終端機仍是貼上路徑。
- [ ] 在終端機 `touch x`，2 秒內出現在面板。
- [ ] 焦點在列表時，⌘C／⌘V／⌘A／空白鍵不會被 WebView 預設行為（捲動、全選文字）搶走。
- [ ] 離開面板後打字直接進終端機（含中文輸入法，照 `docs/keyboard-input.md` 抽測）；`docs/window-drag.md` 清單重跑。

## 彈出成獨立視窗

標題列的「彈出」按鈕（`#files-popout`）把目前頁籤的檔案面板移到獨立視窗；視窗裡同一個按鈕變成「放回頁籤」。

- 視窗是 `files.html`（入口 `src/files-window.ts`），Rust 的 `open_files_window`／`close_files_window`（`src-tauri/src/preview.rs`）建立與關閉。label 為 `preview-files-<tabId>`，每個頁籤一個；沿用 `preview-` 前綴，所以不算終端機視窗，最後一個終端機視窗關閉時會一併關掉。
- 視窗內跑的是同一份 `initFilesPanel`（host 的 `standalone: true`）。需要終端機的動作（在新頁籤開啟終端機、在終端機中編輯、插入路徑、預覽）用 `emitTo(origin, "files-request", …)` 送回原視窗處理；面板狀態用 `files-state` 回報，原頁籤的 `tab.files` 因此保持最新並照常存檔。終端機換目錄時，原視窗用 `files-cwd` 通知視窗跟隨。
- 狀態：`FilesState.detached`（`SavedFiles.detached`）為真表示彈出中，此時 `open` 仍為真，但頁籤內的面板不顯示（`shownInTab`）。重啟後 `restoreSnapshot` 會重新開出視窗。⌘O／右上角按鈕在彈出中只會把視窗帶到前面。
- 放回：視窗送 `files-dock`，頁籤取回狀態並顯示面板。直接關閉視窗等於放回並關閉面板（`close: true`）；結束 App 時視窗是被銷毀的，不會改動 `detached`，所以下次啟動仍會彈出。關閉頁籤會一併關掉它的視窗。
- 視窗大小在調整後 300ms 存進 `localStorage("files-window-size")`，下次彈出沿用（所有頁籤共用）。視窗位置沒有記。
- 視窗是獨立 WebView，Quick Look 與檔案操作走 `native` 的 `files-*` op，依視窗 label 回報事件（`native-event` 由視窗自己監聽）。
