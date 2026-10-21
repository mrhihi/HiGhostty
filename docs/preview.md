# 檔案預覽窗

每個頁籤可以在終端機旁（右側或下方）開一個預覽窗，顯示指定檔案，檔案被改動時自動更新。用途：看 agent 正在寫的計畫、文件、圖片。使用者從檔案面板右鍵「在預覽窗開啟」、指令選單，或 agent 用 `highostty ctl preview open` 開啟。預覽窗開著時，在檔案面板點選／方向鍵移到其他檔案（含三欄的子欄）會直接換成該檔；資料夾、多選不影響，預覽窗沒開時不會自動打開，改名、新增、重整等程式化選取也不會換檔（只在 `files-panel.ts` 的使用者操作處呼叫 `followPreview`）。

## 架構

- 純狀態與幾何：`src/preview.ts`（`splitBox`、`ratioFromPointer`、`previewKind`、`scrollAfterUpdate`、`linkTarget`），測試在 `tests/preview.test.mjs`。DOM 與輪詢：`src/preview-panel.ts`。讀檔：`src-tauri/src/preview.rs`。
- **不用 `overlay-cutout`，也不放進分割樹。** 終端機 NSView 只會蓋在 `layout` op 送出的矩形上。`updateLayout()` 先用 `splitBox` 把 `#terminals` 切成兩塊，終端機的 `rectangles()`（含 zoom）只用終端機那塊，預覽窗是 `#terminals` 內剩下那塊的 HTML。所以不會被原生 view 蓋住，也不與 snippet／attention 的 cutout 衝突。
- 分割樹（`model.ts`）的 leaf 在 `main.ts` 到處被當成終端機 id，預覽窗不是終端機，所以刻意不放進去；代價是每個頁籤只能開一個預覽。
- 視窗太小（寬 < 200px 或高 < 120px）時預覽自動隱藏，終端機取回整塊。
- `#terminals` 內的 `.surface-outline` 每次 layout 重建，只能移除 `.surface-outline`，不可對 `#terminals` 呼叫 `replaceChildren`，否則會連預覽窗一起清掉。

## 獨立視窗（彈出）

- 預覽窗標題列的「彈出成獨立視窗」鈕，或 `ctl preview window <path>`（完整模式），會把檔案開在獨立視窗並關掉頁籤旁的預覽。視窗內容與頁籤旁完全相同（共用 `src/preview-view.ts`），一樣自動更新、點 `.md` 連結換檔。
- 入口是獨立頁面 `preview.html`＋`src/preview-window.ts`（`vite.config.ts` 為兩頁建置），不載入 `main.ts`：沒有終端機、沒有原生層。路徑由 `open_preview_window` 注入的 `window.__HIGHOSTTY_PREVIEW_PATH__` 傳入。
- 視窗 label 是 `preview-<路徑 hash>`，同一個檔案只會有一個視窗，再要求一次就是把它帶到前景。
- **預覽視窗不是終端機視窗**，Rust 列舉視窗時一律要排除（`preview::is_preview_window`）：`control.rs` 的 `expected` 視窗數（否則每個 ctl 指令都等不到「全部回覆」而拖到逾時）、`list_windows`（⌘ 切換視窗）、`ExitRequested`／`Opened` 挑選接收事件的視窗（否則 quit 事件送給不會處理的預覽視窗，App 關不掉）。最後一個終端機視窗關閉時，預覽視窗跟著關閉。
- `ctl preview window` 標 `write: true`：它會多開一個視窗，超出「唯讀」的定義；`--focus` 不提供，視窗不搶焦點。

## 自動更新

- 預覽窗可見時每 500ms 呼叫 `preview_stat`（`metadata` 的 mtime＋size），變了才 `preview_read`。
- **刻意用輪詢而不是對檔案做 watch**：agent 與編輯器常用「寫暫存檔再 rename」存檔，對舊 inode 的 watch 會失效；對路徑 stat 不受影響。
- 檔案不存在時顯示等待訊息並繼續輪詢，檔案重新出現就自動恢復。
- 重繪後捲動位置：原本在底部（24px 內）就繼續貼底（跟著 agent 往下寫），否則維持原位。
- 切走頁籤或關閉預覽就停止輪詢；`generation` 計數避免慢的讀取蓋掉新的檔案。

## 內容

- Markdown 欄寬與字級各自獨立：標題列的百分比輸入框可直接輸入數字或用旁邊的下拉選單選（30–100% 預覽窗寬，預設 100%，存在 localStorage `preview-width`，同樣跨視窗同步）；預設即最寬，只剩 padding。
- 欄寬與字級的 CSS 變數設在 `.preview-body`，不是 `#preview`：`preview-panel.ts` 每次 layout 都整個覆寫 `#preview` 的 `style.cssText`，設在那裡的變數會在視窗改變大小時被清掉而退回預設。
- Markdown 預設 16px，標題列的 A−／A+ 可調（11–32px，存在 localStorage，頁籤旁與獨立視窗共用並即時同步），對 Markdown 與純文字／程式碼顯示（文字檔預設 12px，存在 localStorage `preview-text-font-size`，與 Markdown 的 `preview-font-size` 各自獨立；頁籤旁與獨立視窗共用）。標題列的 ☀／☾ 鈕切換背景白底／深色（Markdown、Word 與文字／程式碼各自記住，localStorage `preview-theme`／`preview-text-theme`，跨視窗同步）；預設 Markdown 白底、文字深色。PDF／投影片固定白底。Markdown 配色用 `--md-*` 變數，匯出 PDF 一律白底。
- Markdown：`marked`（GFM）轉 HTML 後**一定**經 `DOMPurify.sanitize`。連結只處理三種：`http(s)` 交給 `preview_open_url`（只接受 http／https，走 `open`）、相對或絕對的 `.md` 連結在預覽窗內換檔、其餘（`file:`、`javascript:`、錨點、其他副檔名）一律忽略。Markdown 內的本機圖片（相對路徑，依該 .md 所在資料夾解析，`localImagePath`）在 sanitize 後由 `loadLocalImages` 用 `preview_read`（kind `image`，15 MB 上限）換成 data URL；`http(s)`、`data:` 與其他協定的圖片不處理，讀不到則維持破圖並顯示 alt。
- 文字：`<pre>` 等寬顯示；上限 2 MB，超過截斷在字元邊界並提示。含 NUL 或非 UTF-8 視為二進位，不預覽。
- 匯出 PDF：Markdown／Word 標題列的「PDF」鈕。把渲染好的內容複製到 `#print-root`（螢幕上隱藏，列印時是唯一顯示的元素），再由 `preview_print`（`WebviewWindow::print`）開 macOS 列印面板，從 PDF 選單「儲存為 PDF」；檔名預設為檔案名。列印版強制白底、`@page` 邊界 16mm，`afterprint` 後清空。
- 程式碼：副檔名／檔名（`Makefile`、`Dockerfile`）對到 `codeLanguage`（`src/preview.ts`），用 highlight.js `common` 高亮（動態載入）；超過 512 KB 退回純文字。Markdown 的 ```lang 區塊同樣高亮。
- Mermaid：Markdown 的 ```` ```mermaid ```` 區塊由 `renderMermaid`（`preview-render.ts`）動態載入 `mermaid`，`securityLevel: "strict"` 渲染成 SVG 後再經 `DOMPurify.sanitize`（svg＋html profile），原始碼存在 `data-source`。渲染一律序列化（`mermaid.initialize` 是全域的）。語法錯誤時保留原程式碼區塊並加一行提示，不影響其餘內容。切換 ☀／☾ 時用 `data-source` 重畫；匯出 PDF 在列印副本內以 light 主題重畫。
- PDF／Word／PPT：`preview_bytes`（上限 50 MB，二進位 IPC）取位元組，由 `src/preview-render.ts` 以 pdfjs-dist（逐頁 canvas，只畫可見頁）、mammoth（.docx→HTML 再 `DOMPurify.sanitize`）、pptx-preview 渲染；函式庫皆動態載入。只支援新格式，.doc／.xls／.ppt 仍顯示「二進位檔案，無法預覽」。CSP 為此加了 `worker-src 'self' blob:` 與 `img-src blob:`。
- Excel（.xlsx／.xlsm）：`read-excel-file/universal` 讀所有工作表，頂端分頁鈕切換；格子一律用 `textContent`。只顯示值（公式顯示快取結果）、無儲存格樣式，上限 5000 列×200 欄。注意 `previewKind` 回 `sheet` 時 `render` 必須有對應分支，否則會被當成投影片交給 pptx-preview（畫面全黑）。
- draw.io（.drawio／.dio）：`previewKind` 回 `diagram`，走 `preview_read` 文字路徑（不是 binary kind）。渲染用 jgraph 官方 `viewer-static.min.js`（v28.1.2，Apache-2.0，放在 `public/drawio/`，不經 Vite 打包），跑在同源 iframe `/drawio/frame.html` 內，避免 `mx*` 全域汙染主頁；`config.js` 把 viewer 預設的 `viewer.diagrams.net` 路徑改成本地（CSP 也會擋外連）。`renderDiagram`（`preview-render.ts`）以 `postMessage` 傳 XML、只接受該 iframe 的回覆。自動更新時走 `Rendered.update`，不重建 iframe，frame 內重畫並維持目前頁籤；失敗時 dispose 並顯示錯誤，輪詢繼續。固定白底，沒有 A±／欄寬／主題／PDF 鈕。`.drawio.svg`／`.drawio.png` 仍是圖片。更新 viewer：換掉 `viewer-static.min.js` 與 LICENSE，並改這裡的版本號。
- HTML（.html／.htm／.xhtml）：`previewKind` 回 `page`，**JavaScript 會執行**。`renderPage`（`preview-render.ts`）把 `hgpage://localhost/<絕對路徑>` 放進 `sandbox="allow-scripts allow-forms allow-modals"` 的 iframe；`preview::serve_page`（`preview.rs`，`main.rs` 以 `register_uri_scheme_protocol` 註冊）從磁碟提供該檔與它引用的相對 css／js／圖片。安全靠三件事，缺一不可：**sandbox 絕不加 `allow-same-origin`**（否則頁面 script 與 App 同源，可呼叫 Tauri IPC）；protocol 不送 CORS 標頭（script 不能 fetch 讀回檔案）；`frame-src` 只放行 `hgpage:`。頁面載入後不受 App CSP 限制，可連外網。頁內連結由頁面自己處理（外層攔不到，點到外站會在 iframe 內開）。自動更新是重載 iframe，捲動位置不保留。固定白底，沒有 A±／欄寬／主題／PDF 鈕。
- 圖片：png／jpg／gif／webp／svg／bmp／ico，上限 15 MB，以 data URL 傳到前端。

## 狀態與權限

- `tab.preview` 只存在記憶體，不寫進 `session.json` 或收藏，重開 app 不會回來。
- 收藏可設定「預設預覽檔案」（收藏編輯頁的「預設預覽」，存成 `SavedTab.preview`，**相對於頁籤工作目錄**的路徑；選取器只接受工作目錄內的檔案，否則報錯，用 `relativeToDir`／`resolveInDir` 轉換）。從收藏開新頁籤（`openFavorite`、群組展開的 `openFolder`）時，以新頁籤的工作目錄解析路徑，檔案存在就以下方位置開預覽（`showFavoritePreview`）；已開啟的頁籤被切回來不會重開。啟動時還原的頁籤不會觸發，檔案不存在則略過。
- `ctl preview open|close|status` 標 `write: false`：它只改畫面配置，符合「唯讀」的定義（不開頁籤、不送輸入、不改持久資料、不搶焦點、不開別的 App）。這個判定若改變，要同步改 `docs/agent-control.md` 與 skill。
- 預覽任意路徑等於讀取使用者能讀的任何檔案，所以 skill 要求 agent 不預覽機密檔案；預覽內容只顯示在使用者自己的畫面，不回傳給 agent。

## 驗收清單（debug 與 release 各一次；`npm test` 不涵蓋）

1. 檔案面板右鍵一個 .md →「在預覽窗開啟」：右側出現預覽，終端機縮到左邊且沒被蓋住；指令選單「切換預覽位置」改成下方，再切回。
2. 拖曳分隔線調整大小，終端機隨之縮放（`stty size` 變化）；視窗縮到很小時預覽自動隱藏。
3. `⌘D` 分割、zoom、切換頁籤都正常；切到沒有預覽的頁籤預覽消失，切回來又在。
4. `ctl preview open some.md`（唯讀模式）。另開一個終端機分別用 `echo >> some.md`、vim 存檔（rename）、`rm` 後重建，1 秒內都更新；捲到底時貼底，捲到中間時位置不跳。
5. 開 tmux 頁籤，在裡面跑 `ctl preview open`，預覽出現在該頁籤。
6. 開 .txt、.png、二進位檔、超過 2 MB 的文字檔：分別顯示文字、圖片、「二進位檔案，無法預覽」、截斷提示。
7. Markdown 含 `<script>`、`<img onerror=…>`、`[x](javascript:alert(1))`、`[x](file:///etc/hosts)` 不會執行或開啟；`https://` 連結用瀏覽器開；`[x](other.md)` 在預覽窗內換檔；含 `![](../images/a.png)` 相對圖片的 .md（含從連結換檔進入、與直接開啟）都顯示圖片。
8. 預覽窗開著時按 ⌘⇧P（snippet palette）與待處理 drop：兩者正常顯示，預覽窗不受影響。
9. 按預覽窗右上角的關閉，焦點回到終端機，可直接輸入。
10. 按「彈出成獨立視窗」：新視窗顯示同一份內容，頁籤旁的預覽消失；改檔案兩邊（再彈出一次同一檔）都只有一個視窗、內容會更新。
11. 預覽視窗開著時：`ctl whoami`、`ctl tab list` 立刻回應（不拖到逾時）；⌘Q 能正常結束；⌘` 切換視窗不會停在預覽視窗上。
12. 關掉所有終端機視窗，預覽視窗跟著關閉。唯讀模式下 `ctl preview window x.md` 回 `forbidden`，完整模式下開出視窗且不搶焦點。
13. 開 .md：背景是白底；A+／A− 改變文字大小，重開 App 後仍保留；彈出的獨立視窗同步變化；開 .txt／.ts 時 A+／A− 也能調整文字大小（欄寬輸入框與 PDF 鈕仍只在 Markdown 顯示），圖片／PDF 沒有。預設位置在終端機下方；獨立視窗按「放回頁籤」回到原頁籤的下方預覽，視窗關閉（原視窗已關時改回主視窗）。
14. Markdown／Word 按標題列「PDF」：出現列印面板，預覽內容為白底且只有文件本身（沒有終端機、側欄、標題列）；多頁內容正確分頁；PDF 選單「儲存為 PDF」檔名預設為檔案名；程式碼區塊與表格不被截斷。取消後視窗標題回復。頁籤旁與獨立視窗各測一次；.txt／圖片沒有 PDF 鈕。
15. 開 .ts／.rs／.py／Dockerfile／Makefile：有語法高亮；Markdown 的 ```ts 區塊有高亮；超過 512 KB 的程式檔退回純文字。
16. 開 .pdf（多頁）：逐頁顯示、捲動時才畫、拖分隔線後重新貼合寬度；.docx 含表格與圖片；.pptx 每張投影片都有畫面；.xlsx 多工作表可切換、表頭固定；.doc／.xls／.ppt 顯示「二進位檔案，無法預覽」。快速連續切換不同檔案，最後顯示的一定是最後選的那個。
17. 預覽窗開著時，在檔案面板點另一個檔案／用方向鍵移動／在三欄子欄點檔案：預覽立即換檔、位置大小不變；點資料夾或多選維持原檔；關閉預覽後點檔案不會自動打開；改名、新增檔案、切換目錄不會換掉預覽；獨立視窗不受影響。

18. 開 .md 與 .txt／.ts：☀／☾ 鈕切換背景，Markdown 深色下連結、程式碼區塊、表格邊線清楚可讀；重開 App 與獨立視窗仍保留；匯出 PDF 仍是白底；PDF／圖片沒有此鈕。App 左下角顯示小圖示與版本號（與 package.json 一致）。


19. 開 .drawio（壓縮與未壓縮各一、含多頁）：圖形正確、下方可切頁與縮放；用 draw.io 存檔 1 秒內更新、不閃白、停在原本那一頁；把檔案截斷顯示錯誤、修回自動恢復；`.drawio.svg` 仍是圖片；斷網仍可顯示；Web Inspector 無 CSP 違規；彈出獨立視窗也正常。
20. 收藏編輯頁設定「預設預覽」為工作目錄內的一個 .md（欄位顯示相對路徑；選取器預設開在工作目錄；選工作目錄外的檔案會報錯）→ 儲存；從收藏「開啟」或「在新頁籤開啟」，終端機下方自動出現該檔預覽；群組展開也會對每個新頁籤開預覽；切到已開啟的頁籤不會重開。改成「清除」後存檔，再開新頁籤就不會開預覽。把收藏指向的檔案改名或刪除後開頁籤，不出現預覽也不報錯。編輯中途切到「新增群組」再回來，選取的預覽路徑保留。
21. Markdown 含 flowchart、sequence、gantt 的 mermaid 區塊：顯示成圖；改檔案自動重畫；☀／☾ 切換圖跟著換色；語法錯誤的區塊顯示原碼加提示、其他內容正常；label 含 `<script>`／`<img onerror>` 不執行；匯出 PDF 的圖是白底；斷網可用且 Web Inspector 無 CSP 違規。
22. 開含 `<script>`、外部 css／相對路徑圖片的 .html：以頁面呈現且 JS 有執行（例如按鈕改 DOM）；頁面內 `window.parent.__TAURI__`、`fetch("hgpage://...")` 取不到東西；改檔案 1 秒內重載；彈出獨立視窗也正常。
