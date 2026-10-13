# 標題列拖曳交接（修改前必讀）

視窗頂端的 `<header>`（`src/main.ts` 的 `root.innerHTML`）同時是 HiGhostty 的標題列。拖曳它可以移動視窗。這個功能壞過一次：從標題文字開始拖曳時，有時拖不動。修改 header 的結構、`data-tauri-drag-region`、header 內的事件處理，或升級 Tauri 前，請先讀完本文件。

## 目前的做法

```html
<header data-tauri-drag-region="deep">
  <b>◈ HiGhostty</b><span id="current">…</span>
  <button id="browse">…</button> …
</header>
```

- 拖曳**完全交給 Tauri 內建的 `drag.js`**。Tauri 2 會自動把它注入每個 webview，不需要、也不可以再自己呼叫 `startDragging()`。
- `"deep"` 表示 header 的整個子樹都是拖曳區，包括標題文字、`#current` 和空白處。
- `<button>`、`<input>`、`<select>`、`<a>`，以及帶 `tabindex`、`role="button"` 等屬性的元素，會被 `drag.js` 自動排除，點下去仍是一般點擊。
- 雙擊拖曳區會放大／還原視窗（macOS 在 mouseup 時觸發；按下後若有移動就取消），這也是 `drag.js` 的內建行為。
- capability 需要 `core:window:allow-start-dragging`（`src-tauri/capabilities/default.json`）。`drag.js` 雙擊放大用的 `internal_toggle_maximize` 包含在 `core:default` 裡。

`drag.js` 的原始碼在 `~/.cargo/registry/src/*/tauri-2.*/src/window/scripts/drag.js`。行為有疑問時，以你使用的 Tauri 版本裡的這個檔案為準。

## 不可違反的規則

1. **不要在拖曳區上自己綁 `mousedown` 再呼叫 `getCurrentWindow().startDragging()`。**
   - 原本的寫法是在帶 `data-tauri-drag-region` 的元素上另外綁 `mousedown` → `win.startDragging()`。這樣按一下會送出**兩個** `start_dragging` IPC：一個來自我們的 listener，一個來自 `drag.js` 在 document 上的 listener。
   - IPC 是非同步的。原生端執行 `performWindowDragWithEvent:` 時，用的是「那一刻的 `NSApp.currentEvent`」。兩個請求互相競爭，滑鼠按下後若移動得快，其中一個拿到的已經不是 mouseDown，拖曳就失敗。
   - 我們的 listener 也沒有 `preventDefault()`，WebKit 會開始文字選取／拖放追蹤，搶走後續的滑鼠事件。
   - 症狀：從標題文字開始拖曳時**偶爾**拖不動，從空白處拖則正常或完全不能拖（取決於屬性放在哪裡）。
   - 需要自訂行為（例如拖曳前做其他事）時，改用 `data-tauri-drag-region="false"` 把該元素排除，再自己完整處理，**不要**和 `drag.js` 疊在同一個元素上。

2. **`data-tauri-drag-region` 不帶值（或 `"true"`）時，只有「直接點在該元素上」才算數。**
   - 點到它的子元素（文字外包的 `<span>`、圖示 `<svg>` 等）不會觸發拖曳。這是 Tauri 2 的設計，和 Tauri 1 不同。
   - 要讓整個區塊含子元素都可拖曳，用 `"deep"`。目前 header 用 `"deep"`，子元素不需要再各自標記。

3. **header 裡新增可點擊的控制項，要確認它會被排除。**
   - 原生的 `<button>`、`<input>` 等元素會自動排除。用 `<div>`／`<span>` 做成的按鈕，要加 `role="button"` 或 `tabindex="0"`，或直接標 `data-tauri-drag-region="false"`，否則點擊會變成拖曳視窗。
   - 反過來，可點擊元素若自己帶了 `data-tauri-drag-region`，就會變成拖曳區。

4. **標題文字保持 `user-select: none`（`src/style.css` 的 `header b`、`#current`）。**
   - `drag.js` 在 mousedown 時已經 `preventDefault()`，但雙擊（`detail === 2`）在 macOS 會提早 return、不呼叫 `preventDefault()`，沒有這個樣式就會反白文字。

5. **header 不要被其他元素覆蓋，也不要對它設 `pointer-events: none`。**
   - 拖曳靠的是網頁收到 mousedown。上層若有透明元素擋住（例如 `position: fixed` 的 overlay 延伸到頂端），事件就不會進到 header。

## 原生視窗設定的關係

- `bridge.m` 依 Ghostty 的 `macos-titlebar-style` 設定標題列：`transparent`／`hidden` 會隱藏原生標題，`hidden` 另外加上 `NSWindowStyleMaskFullSizeContentView`。這時原生標題列區域被 webview 蓋住，拖曳完全依賴 header。
- header 左側 `padding-left: 82px` 是為 macOS 紅綠燈按鈕保留的空間，不要縮小，否則按鈕會蓋住標題文字。
- 不要為了修拖曳問題改用 `-webkit-app-region: drag`。WKWebView 不支援這個 CSS 屬性，那是 Electron 的機制。

## 驗收清單

改完後要在實際 App（`cargo xtask build` 或 `npm run tauri dev`）裡操作，`npm test` 不涵蓋這部分：

- [ ] 從「◈ HiGhostty」文字按下並拖曳，連續試 10 次以上，每次都能移動視窗，包括按下後立刻快速移動。
- [ ] 從 `#current` 路徑文字、header 空白處開始拖曳，都能移動視窗。
- [ ] 快速連點標題文字三下後再拖曳，不會卡住或選取文字。
- [ ] 雙擊 header 空白處會放大／還原；雙擊後立刻移動滑鼠則不會放大。
- [ ] 「目錄 ⌘O」「Ghostty 設定」「側欄」按鈕點擊正常，不會拖動視窗。
- [ ] 標題文字無法被反白選取。
- [ ] 分別測 Ghostty `macos-titlebar-style` 為預設與 `hidden` 兩種情況。
