# 分割窗格調整大小

- 分割窗格之間 6px 的 gap（`model.ts` 的 `rectangles()` 留的）沒有原生 NSView 覆蓋，分隔線是放在那裡的 HTML（`.split-divider`，`main.ts` 的 `syncDividers`／`wireDivider`），不用 `overlay-cutout`。
- 幾何與換算只放 `src/model.ts` 的 `dividers()`、`ratioFromDrag()`，測試在 `tests/model.test.mjs`。比例限制 0.1–0.9，與鍵盤 `resizeSplit` 共用 `clampRatio`。
- `updateLayout()` 以 index **重用**分隔線元素，不可重建：拖曳中每幀都會重排，重建會讓持有 pointer capture 的元素消失、拖曳中斷。只移除 `.surface-outline`，不對 `#terminals` 呼叫 `replaceChildren`。
- 放開滑鼠、雙擊（回 0.5）、鍵盤 resize／equalize 後呼叫 `scheduleSessionSave()`；比例隨 `savedTree` 存進 session／收藏。zoom 時沒有分隔線。
- 視窗縮放途中（尤其雙擊標題列的縮放動畫）網頁收不到 resize，要等動畫結束才送 `layout`。`bridge.m` 的 `observeWindowResize` 監聽 `NSWindowDidResizeNotification`，依最近一次 layout 的位置（`layoutRect`／`layoutArea`／`layoutWebSize`）先調整終端機，之後的 `layout` 再校正。模型是「終端機區域的左／上邊界固定、右／下邊距固定，減少的寬高全由區域吸收（放大時不跟隨：縮放動畫期間網頁內容不更新，終端機先長大會超出畫面上看得到的介面，等動畫結束的 `layout` 再補上），區域內的窗格才按比例」；不可改回整體按比例（側邊欄、標題列是固定尺寸，整體按比例會讓左邊界在動畫中超前或落後）。這條路徑不可隱藏 view 或搶焦點。
- 縮放剛結束（0.25 秒內）若 `layout` 的 `viewportWidth` 與網頁寬度不符，代表網頁還用舊寬度排版，該請求視為過時直接略過；`layout` 的座標換算只有 `viewportWidth` 一個比例，過時請求會把 y 與高度也乘錯。
- frame 必須對齊裝置像素（`placeSurface` 的 `backingAlignedRect`）：libghostty 會丟棄大小與 layer 邊界不符的畫面，帶小數的 frame 會讓畫面停在舊內容。

## 驗收清單

- [ ] ⌘D、⌘⇧D 做出巢狀分割，拖每條分隔線：游標正確、終端機即時重排（`stty size` 變化），極端停在 10%／90%。
- [ ] 拖曳中游標移到終端機上仍持續拖動；放開後焦點與輸入正常。
- [ ] 雙擊分隔線回到對半。
- [ ] zoom 時無分隔線；開預覽窗時兩種分隔線都能拖；有 git 資訊列的窗格大小正確。
- [ ] 重開 App（含 tmux 頁籤）與從收藏開啟，比例保留。
- [ ] ⌘⇧P／TODO 浮層開著時不受影響。
- [ ] 雙擊標題列放大／縮小、拖邊框：終端機跟著視窗動，不是動畫結束後才跳；結束後大小正確（`stty size`）、焦點不丟。
