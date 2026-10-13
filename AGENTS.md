# HiGhostty 給 AI 代理的注意事項

專案說明、建置與檢查指令見 `README.md`。

## 鍵盤輸入（`src-tauri/native/bridge.m` 的 `HGSurface`）

修改任何鍵盤／輸入法相關程式碼前，先讀 `docs/keyboard-input.md`。重點：

- 輸入法傳入的字串（`insertText:` 等）一定要 `copy` 後再保存，否則文字會在使用前被清空。
- AppKit 回呼不可讓 Objective-C exception 漏出，否則穿過 tao 的 Rust `sendEvent:` 會直接 abort；沿用 `@try/@catch` + `reportInputException:` 的包裝模式。
- 只有 KeyDown／KeyUp 事件可以讀 `characters` 系列屬性，`flagsChanged` 讀取會丟 exception。
- debug build 會啟用 `HG_DEBUG_INPUT` trace，行為與 release 不同；兩者都要實測。
- 改完照 `docs/keyboard-input.md` 的驗收清單實際操作，不能只靠程式碼審閱或 `npm test`（測試不涵蓋原生輸入）。

## 標題列拖曳（`src/main.ts` 的 `<header>`）

修改 header 結構、`data-tauri-drag-region`、header 內的滑鼠事件，或升級 Tauri 前，先讀 `docs/window-drag.md`。重點：

- 拖曳完全交給 Tauri 自動注入的 `drag.js`；不可在拖曳區另外綁 `mousedown` 呼叫 `startDragging()`，兩者疊加會偶發拖不動。
- header 用 `data-tauri-drag-region="deep"`；不帶值的屬性只對「直接點在該元素上」有效，點到子元素不會拖曳。
- header 內新增的自製按鈕要能被排除（原生 `<button>`，或加 `role="button"`／`data-tauri-drag-region="false"`）。
- 改完照 `docs/window-drag.md` 的驗收清單在實際 App 操作，`npm test` 不涵蓋。
