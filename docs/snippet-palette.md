# 指令片段面板（⌘⇧P）

從視窗上方下拉的輸入框＋候選清單，輸入關鍵字即時過濾，選取後把片段文字插入目前終端機。片段可綁定目錄。

## 範圍規則

- `scope` 為 `"global"` 或絕對目錄；綁定目錄的片段在該目錄**及所有子目錄**的終端機可見。
- 排序：越近的目錄越前面（scope 越長）→ 最近使用 → 名稱。全域排最後。
- 純邏輯在 `src/snippets.ts`（`applicable`、`filterSnippets`、`expand`），測試在 `tests/snippets.test.mjs`。

## 資料

- `data_dir/snippets.json`：`{ revision, items: [{ id, name, text, scope, keywords?, run?, createdAt }] }`。
- `src-tauri/src/snippets.rs`：原子寫入，`revision` 樂觀鎖（多視窗），寫入後 emit `snippets-changed`。名稱、內容、範圍不可空白。
- 「最近使用」存 `localStorage("snippet-recent")`。

## 面板如何疊在終端機之上

原生終端機 NSView 在 WebView 之上，HTML 預設會被蓋住。做法是「挖洞」而非縮小終端機：

- 前端量 `#palette-drop` 的矩形，呼叫 `native({ op: "overlay-cutout", x, y, width, height, viewportWidth })`；寬高為 0 代表取消。
- `bridge.m` 的 `applyCutout()` 用 `layer.mask`（even-odd）把每個 `HGSurface` 與該矩形的交集遮掉，並讓 `-hitTest:` 在洞內回傳 `nil`，滑鼠才會穿透到下方面板。
- `layout` op 改完 frame 後會重套，視窗縮放、分割時遮罩跟著動。終端機尺寸不變，沒有 SIGWINCH。
- 若遮罩在某些情況下殘留，先檢查 `overlay-cutout` 是否有送出全零（面板關閉時）。

## 鍵盤

⌘⇧P 在原生 local monitor 攔截（`bridge.m`，與 ⌘⇧B 同處），因為終端機聚焦時按鍵不會到 WebView。

| 按鍵 | 動作 |
|---|---|
| ↑↓ | 移動選取（循環） |
| ↵ | 插入文字（片段若標「自動執行」則補 Enter） |
| ⌘↵ | 插入並執行 |
| ⌘E | 編輯選中片段 |
| ⌘⌫ | 刪除（再按一次確認） |
| Esc | 關閉並把焦點還給終端機 |
| 面板右上 ＋ | 新增；沒有結果時也有「新增片段『…』」列 |

### 指令（`:` 開頭）

輸入 `:` 開頭的查詢時，清單改列指令而不是片段，↵ 執行。指令表由主程式以 `commands` 注入（`src/main.ts`），目前只有 `:todo`（開啟 ⌘⇧L 待辦浮層，見 `docs/todo-drop.md`）。新增指令只要在 `commands` 加一筆。

不用 ⌘N 新增：Ghostty 的 app 層綁定（new_window）會先吃掉。輸入法選字中（`isComposing`）不處理 ↑↓／Enter／Esc。

## 關閉後的焦點

⌘D 等 Ghostty surface 層綁定只在終端機 NSView 是 firstResponder 時有效；面板關閉後焦點若留在 WebView，快捷鍵就「有時候按不出來」。

- 所有關閉路徑（Esc、再按 ⌘⇧P、點面板外、插入片段）都要把焦點還給終端機；點到輸入元素或視窗失焦（blur）除外。
- `overlay-cutout` 全零時帶 `restoreFocus`，`bridge.m` 若發現 firstResponder 仍是 WebView 會兜底切回終端機。
- `open()` 的 `focus-web` 是非同步；期間若已被關閉，要改把焦點送回終端機。

## 維護介面

- 面板內：新增、編輯（⌘E）、刪除，表單與側欄共用 `createForm()`。
- 側欄 Rail「指令片段」：依範圍分組（可收合、目前所在目錄標 ●）、搜尋、行內「↵」插入、點列進入編輯頁、群組標題的 ＋ 在該範圍新增。把 Finder 資料夾拖到此面板會以該目錄為範圍新增。
- 變數：`${cwd}`、`${dir}`、`${home}`。

## 驗收清單（`npm test` 不涵蓋，需實機；debug 與 release 各做一次）

0. ⌘⇧P → ↵ 插入片段（或 Esc、點面板外）→ 立刻 ⌘D，重複 20 次都能分割。

1. 終端機聚焦時 ⌘⇧P 開啟；再按一次或 Esc 關閉，焦點回終端機，`stty size` 前後不變。
2. 面板蓋在終端機上方（不被遮住）；洞內可點擊與選取，洞外仍可點終端機。
3. 在 `~/proj/src` 看到全域＋`~/proj`＋`~/proj/src` 片段；`cd` 到其他目錄後清單改變。
4. 輸入「gs」過濾並高亮；↑↓／↵ 插入但不執行；⌘↵ 插入並執行。
5. 注音輸入法選字中按 ↵ 不會誤選取。
6. 面板內新增／編輯／刪除；側欄新增／編輯／刪除／拖入資料夾。
7. 兩個視窗：一邊儲存，另一邊自動更新；同時編輯產生「已在其他視窗更新」提示。
8. 視窗縮放、多分割、切換頁籤、`background-opacity<1` 時遮罩位置正確且關閉後無殘影。
9. 檔案面板滿版、沒有頁籤時開啟面板不報錯（無頁籤時插入按鈕停用）。
