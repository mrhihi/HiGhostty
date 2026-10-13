# 原生版驗證

## 已通過

- TypeScript/Vite 生產建置、Rust arm64 建置、AppKit 橋接語法檢查與 `.app` 打包。
- Ghostty 1.3.1 函式庫含 arm64、x86_64；Rust x86_64 目標亦可編譯。Intel 硬體未實測。
- arm64 與 x86_64 執行檔已合併為 Universal `.app`，ad-hoc 簽章驗證通過；Universal app 已在 Apple Silicon 啟動。
- Apple Silicon 實機啟動與 Metal 繪圖。既有 Ghostty 設定載入成功，面板顯示 1.3.1、18pt 字級及 0.9 背景透明度。
- 貼上繁體中文後字形正確；終端游標呈現正常短線。
- 2026-10-13 修正後於 debug build 實測：一般字元可正常輸入，按修飾鍵不再中止程式（原因與規則見 `docs/keyboard-input.md`）。
- 目錄樹清楚顯示展開箭頭；樹狀列表、直欄、由上滑出、由下滑出均可切換。
- macOS 原生資料夾挑選器可開啟及取消；`~/Downloads` 解析成功，開啟終端後工作目錄正確。
- `cd /tmp` 立即更新視窗標題；目錄面板保持開啟時會跟隨更新至 `/private/tmp`。
- ⌘T 建立新工作區，⌘D 在目前工作區增加分割終端。
- 閒置 shell 關閉時不會誤警告；執行 `sleep 30` 時會顯示程序警告。取消會保留工作，確認後關閉會終止程序並回到空工作區。
- 空工作區保持深色背景，不會顯示白色區塊。
- 標題文字與左上 macOS 控制鈕留有間距，文字禁止反白選取；標題拖曳由 header 的 `data-tauri-drag-region="deep"` 交給 Tauri 內建 `drag.js` 處理，權限已加入 capability（規則見 `docs/window-drag.md`）。

## 尚未完整驗收

- 收藏項目的新增、編輯、刪除與多視窗同步尚未做 UI 循環驗收。
- 多視窗、快速終端、搜尋、視窗恢復、全域快捷鍵與 macOS 輔助使用權限流程尚未逐項驗收。
- Intel Mac 僅完成 x86_64 編譯，沒有 Intel 硬體供互動驗證。
- Ghostty 原版 Inspector 與自動更新器目前未提供；其他未實作的宿主 action 會顯示提示。

## 建置檢查

```sh
npm test
npm run build
CARGO_TARGET_DIR=/private/tmp/highostty-target cargo test --manifest-path src-tauri/Cargo.toml
```
