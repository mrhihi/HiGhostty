# 檔案面板

每個頁籤各有一個檔案面板，用來查看並操作終端機所在目錄，操作方式比照 Finder。它取代了原本左側 Rail 的「目錄」面板（`docs/ui-drawer-redesign.md` §8）。

## 版面與狀態

```
┌rail┬──────────────────────┬┬─────────────────────────────┐
│    │                      ││ ↑ ~ › proj › src  ⟲ 👁 ⤢ ×  │
│ ▣  │   終端機（目前頁籤）     ││ 名稱 ▲          大小  修改日期 │
│ ★  │                      ││ › 📁 native        —   今天  │
│    │                      ││   📄 main.rs     12 KB 昨天  │
└────┴──────────────────────┴┴─────────────────────────────┘
                            ↑ #files-resizer
```

- `#workspace` 是 flex row：`#terminals` ＋ `#files-resizer` ＋ `#files`。
  - 原生終端機 NSView 疊在 WebView 之上，所以面板只能當兄弟元素擠窄終端機，不能疊上去。
  - 寬度變化由 `ResizeObserver(scheduleLayout)` 自動重排終端機。
- 寬度存在 `localStorage("files-width")`，所有頁籤共用，範圍 240px～視窗寬 70%。
- **滿版**：`#workspace.files-full` 隱藏 `#terminals`。`updateLayout()` 透過 `filesPanel.isFull()` 傳空 rects，原生 surface 全部隱藏，鍵盤交給列表。
- 面板寬度 < 420px 時（container query），只留名稱欄。
- 每個頁籤的狀態存在 `tab.files`（`FilesState`，見 `src/files.ts`）：`open`、`full`、`path`、`follow`、`expanded`。
  - `SavedTab.files` 只存 `open`、`full`，收藏還原時保留面板開合。路徑則一律重新跟隨 cwd。
- `updateLayout()` 一開始呼叫 `filesPanel.sync()`。所有切換頁籤的路徑（點擊、⌘數字、關閉頁籤、還原收藏）都經過這裡，所以不用在每個呼叫點各自同步。

## 檢視模式

標題列的分段按鈕切換「清單」與「三欄」。選擇存在 `localStorage("files-view")`，所有頁籤共用。沒有快捷鍵，因為 ⌘1～⌘9 已用於切換頁籤。

- **清單**：樹狀列表，有名稱、大小、修改日期三欄，點欄頭排序，資料夾可就地展開。
- **三欄**：`上層｜目前｜預覽`，類似 ranger／yazi。`#files-body` 是三欄 grid，比例 1 : 1.4 : 1.2，各自捲動。
  - **上層欄**（`.col-parent`）：列出上一層目錄，目前目錄那一列反白。點資料夾會進入該資料夾，點檔案會回到上層並選取它。
  - **目前欄**（`#files-list`）：和清單模式是同一個元素，選取、鍵盤、右鍵選單、改名、剪貼簿、拖入全部共用。三欄模式不就地展開資料夾，新增資料夾／檔案一律建在目前目錄。
  - **預覽欄**（`.col-preview`）：選取後 120ms 更新。
    - 單選資料夾 → 唯讀列出內容，點其中一列會進入並選取該項。
    - 單選檔案 → 縮圖、名稱、種類、大小、修改日期。
    - 多選 → 「已選取 N 個項目」。
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
| 選取 | 單擊；⌘ 切換；⇧ 範圍；↑↓（⇧ 延伸）；⌘A |
| 展開／收合（清單） | 點三角形；→／← |
| 進入／回上層（三欄） | → 進入選中的資料夾並選第一項；← 或 ⌘↑ 回上層並選回原資料夾 |
| 開啟 | 雙擊或 ⌘↓。資料夾會進入該資料夾，檔案用預設 App 開啟 |
| 上層 | ⌘↑、標題列 ↑（兩種模式都會選回原資料夾） |
| Quick Look | 空白鍵（再按一次或 Esc 關閉）。單選時在 Quick Look 中按 ↑↓ 會移動列表選取；多選時由 Quick Look 自己翻頁 |
| 重新命名 | Enter 或選單。預設選取主檔名；Enter 確定、Esc 取消、失焦確定；輸入法選字中不處理 |
| 拷貝／剪下／貼上 | ⌘C／⌘X／⌘V；在資料夾上按右鍵可「貼到此資料夾」 |
| 複製一份 | ⌘D |
| 丟到垃圾桶 | ⌘⌫ |
| 新增資料夾 | ⇧⌘N（新增後直接進入改名） |
| 滿版 | ⇧⌘F 或標題列按鈕 |
| 焦點回終端機 | Esc：有選取時先清除選取，再按一次才回終端機 |
| 右上角資料夾按鈕 | 標題列最右側的 `#files-toggle`，單純開關目前頁籤的面板；面板開著時按鈕呈選取狀態，沒有頁籤時停用 |
| ⌘O（字母 O）或 ⌘0 | 面板沒開 → 開啟並聚焦；開著但焦點在終端機 → 聚焦列表；焦點已在列表 → 關閉 |

**右鍵選單**用 `@tauri-apps/api/menu` 的 `Menu.popup()` 產生原生 NSMenu，貼近終端機也不會被遮住。
- 項目上：打開、打開方式（預設 App 列第一）、在終端機中編輯、Quick Look、在新頁籤開啟終端機、插入路徑到終端機、拷貝路徑、剪下／拷貝／貼上／複製一份／重新命名、新增資料夾／檔案、在 Finder 中顯示、丟到垃圾桶。
- 空白處：新增資料夾、新增檔案、貼上、在新頁籤開啟終端機、在 Finder 中打開、重新整理。

**在終端機中編輯**：在目前頁籤向右分割，執行 `sh -c '${EDITOR:-vi} "$1"' sh '<path>'`。
- 用 `commandInShell` 先載入使用者 shell，讓 rc 裡設定的 `EDITOR` 生效。
- 透過 `sh -c` 包一層，zsh、bash、fish 都能執行。
- 編輯器結束後保留 shell。滿版時會先退出滿版。

**Finder 拖入**：拖到面板會複製進游標下的資料夾，否則複製進面板目前的資料夾。拖到終端機仍是貼上路徑。

## 剪貼簿

- 「拷貝」寫入每個項目的 `public.file-url`，Finder 可以貼上。第一個 item 另外寫入 shell 引號包好的路徑文字，貼到終端機時和拖放檔案的效果一致。
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

AppKit 相關的操作走 `hg_command` 的 `files-*` op（主執行緒）：`files-pasteboard-write`、`files-pasteboard-read`、`files-pasteboard-text`、`files-open`（可指定 App）、`files-open-with-apps`、`files-reveal`、`files-quicklook`／`-update`／`-close`。另外兩個 op 在 `bridge.m`：
- `insert-text`：把文字送進終端機，不送 Enter。
- `focus-web`：讓 WebView 成為 first responder；⌘O 聚焦列表時需要它。

**Quick Look**：QLPreviewPanel 從 key window 的 first responder 往上尋找 controller。
- WKWebView 本身就實作了 `acceptsPreviewPanelControl:`（WebKit 內建預覽用）。若讓 WebView 當 first responder，panel 會在那一層停下、用 WebKit 的空資料來源，預覽視窗就是空的（早期版本的 bug）。
- 因此 `files-quicklook` 會先把隱形的 `HGQuickLookResponder` view 設為 first responder（記住原本的 responder），再開啟 panel，由它把 `HGQuickLook` 設為 dataSource。
- panel 關閉或失去控制時，`endPreviewPanelControl:` 還原原本的 first responder。若控制權被別人拿走（例如點回網頁），會順便關掉 panel，避免顯示空白。面板關閉時送出 `quicklook-closed` 事件；單選時面板內的 ↑↓ 轉成 `quicklook-key` 事件交給列表。

## 驗收

自動：`npm test`（`tests/files.test.mjs` 涵蓋狀態、選取、排序、路徑引號）、`npm run build`、`cargo check`／`cargo test`。

實機（`CARGO_TARGET_DIR=/private/tmp/highostty-target npm run tauri -- dev`，debug 與 release 各一次）：

- [ ] ⌘O 與 ⌘0 都能開啟、聚焦、關閉；每個頁籤各自記住開合／滿版；切換頁籤時面板跟著換；從收藏還原時保留開合。
- [ ] 拖曳調寬時終端機即時重排，沒有殘影或遮擋；滿版時終端機隱藏，退出滿版後焦點回到終端機。
- [ ] `cd` 後面板跟隨；同頁籤切換分割時跟隨該分割；面板瀏覽別處後暫停跟隨，按「回到終端機目前目錄」恢復。
- [ ] 面板拷貝 → Finder 貼上，以及反向；剪下＋貼上會搬移；同名自動改名；在同一資料夾 ⌘D 產生「副本」；拷貝路徑。
- [ ] 改名與新增資料夾（含中文輸入法選字中按 Enter 不會提前送出）；⌘⌫ 丟到垃圾桶，可從垃圾桶還原。
- [ ] 空白鍵開 Quick Look，預覽視窗有內容（圖片、PDF、程式碼）；↑↓ 切換預覽；再按空白鍵或 Esc 關閉後，鍵盤回到檔案列表；多選時 Quick Look 可翻頁。
- [ ] 清單／三欄切換後模式會記住；三欄的上層欄、目前欄、預覽欄內容正確。
- [ ] 三欄下 ←→ 進出資料夾，回上層時選回原資料夾；點上層欄、預覽欄的項目會跳過去，鍵盤仍在目前欄。
- [ ] 預覽欄：圖片、PDF 顯示縮圖；沒有縮圖的檔案顯示系統圖示與種類；多選顯示數量。
- [ ] 三欄模式下的右鍵、剪下貼上、改名、新增資料夾、Finder 拖入都正常；窄面板（約 360px）仍可用。
- [ ] 打開方式子選單列出 App 並標出預設；雙擊檔案用預設 App 開啟；「在終端機中編輯」在右側分割開啟 `$EDITOR`，結束後保留 shell。
- [ ] 右鍵選單是原生選單，在面板靠終端機那一側按右鍵也不會被遮住。
- [ ] Finder 拖到面板空白處／資料夾列會複製進對應資料夾；拖到終端機仍是貼上路徑。
- [ ] 在終端機 `touch x`，2 秒內出現在面板。
- [ ] 焦點在列表時，⌘C／⌘V／⌘A／空白鍵不會被 WebView 預設行為（捲動、全選文字）搶走。
- [ ] 離開面板後打字直接進終端機（含中文輸入法，照 `docs/keyboard-input.md` 抽測）；`docs/window-drag.md` 清單重跑。
