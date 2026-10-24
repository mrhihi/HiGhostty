# 分割窗格調整大小

- 分割窗格之間 6px 的 gap（`model.ts` 的 `rectangles()` 留的）沒有原生 NSView 覆蓋，分隔線是放在那裡的 HTML（`.split-divider`，`main.ts` 的 `syncDividers`／`wireDivider`），不用 `overlay-cutout`。
- 幾何與換算只放 `src/model.ts` 的 `dividers()`、`ratioFromDrag()`，測試在 `tests/model.test.mjs`。比例限制 0.1–0.9，與鍵盤 `resizeSplit` 共用 `clampRatio`。
- `updateLayout()` 以 index **重用**分隔線元素，不可重建：拖曳中每幀都會重排，重建會讓持有 pointer capture 的元素消失、拖曳中斷。只移除 `.surface-outline`，不對 `#terminals` 呼叫 `replaceChildren`。
- 放開滑鼠、雙擊（回 0.5）、鍵盤 resize／equalize 後呼叫 `scheduleSessionSave()`；比例隨 `savedTree` 存進 session／收藏。zoom 時沒有分隔線。

## 驗收清單

- [ ] ⌘D、⌘⇧D 做出巢狀分割，拖每條分隔線：游標正確、終端機即時重排（`stty size` 變化），極端停在 10%／90%。
- [ ] 拖曳中游標移到終端機上仍持續拖動；放開後焦點與輸入正常。
- [ ] 雙擊分隔線回到對半。
- [ ] zoom 時無分隔線；開預覽窗時兩種分隔線都能拖；有 git 資訊列的窗格大小正確。
- [ ] 重開 App（含 tmux 頁籤）與從收藏開啟，比例保留。
- [ ] ⌘⇧P／TODO 浮層開著時不受影響。
