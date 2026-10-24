# HiGhostty

僅支援 macOS 13+。Rust + Tauri 管理介面，AppKit 原生視圖內嵌 Ghostty 1.3.1，以 CoreText 與 Metal 處理字型、中文輸入法及畫面。

## 開發與安裝包

需要 Xcode、Rust、Node.js 22.6+；Ghostty bootstrap 會下載並驗證固定版本的 Zig 0.15.2。引擎內部 API 與同版標頭綁定，升版必須一起驗證。

```sh
npm install
npm run native:bootstrap
CARGO_TARGET_DIR=/private/tmp/highostty-target npm run tauri -- dev
```

```sh
CARGO_TARGET_DIR=/private/tmp/highostty-target npm run tauri -- build
```

輸出在 `/private/tmp/highostty-target/release/bundle/macos/HiGhostty.app`。開發測試包可使用 `build --debug`，輸出在相應的 `debug/bundle/macos`。目前採本機 ad-hoc 簽署；對外發行須另做 Developer ID 簽署與公證。

把資料夾拖到 Dock／Finder 上的 App icon（或用「打開方式」），會在該目錄開新頁籤；拖入檔案則開其上層目錄。

原生 Ghostty 函式庫包含 arm64、x86_64。要建立完整 universal 應用程式，Rust 也需安裝兩個 target，再使用 Tauri `build --target universal-apple-darwin`。只有 Apple Silicon 的實機可用於目前互動驗證。

也可分別建置 arm64 Tauri app 與 Intel Rust binary，再用封裝腳本合併：

```sh
rustup target add x86_64-apple-darwin
CARGO_TARGET_DIR=/private/tmp/highostty-target npm run tauri -- build --debug
CARGO_TARGET_DIR=/private/tmp/highostty-target cargo build --manifest-path src-tauri/Cargo.toml --target x86_64-apple-darwin --features tauri/custom-protocol
CARGO_TARGET_DIR=/private/tmp/highostty-target scripts/package-universal-macos.sh /private/tmp/HiGhostty-universal.app
```

封裝腳本沿用 arm64 app 的資源，合併兩個 Rust 執行檔並做 ad-hoc 簽署。正式散布仍需 Developer ID 簽署及公證。

bootstrap 將編譯來源、工具鏈、cache 放在 `/private/tmp/highostty-native-build`，複製產物至 `src-tauri/vendor`（不進版控）。可用 `HIGHOSTTY_BUILD_CACHE` 改變 cache 位置，或以 `HIGHOSTTY_ZIG` 指定 Zig 0.15.2。

Xcode 27 的 SDK 使用 arm64e libc stubs 時，bootstrap 自動選 x86_64 Zig（Apple Silicon 需 Rosetta）。Metal shader 使用系統執行期編譯器，無需額外安裝離線 Metal Toolchain。相容補丁僅修改下載的來源／工具鏈，不更動系統 SDK。

若專案在 exFAT，AppleDouble `._` 檔會被 Tauri 當成設定檔讀取；請優先在 APFS 工作，並把 Cargo target 放在 `/private/tmp`。權限檔若出現 UTF-8 錯誤，清理 `src-tauri/capabilities/._*` 後重建。

## 建置與發佈（xtask）

```sh
cargo xtask debug                  # 開發模式（npm run tauri -- dev，輸出目錄同 build）
cargo xtask build                  # 建置 HiGhostty.app（--debug 為開發版）
cargo xtask publish                # 打包 dmg，詢問是否複製到 ~/Applications（--install / --no-install）
cargo xtask clean                  # 清除 Cargo 輸出目錄、dist 等產出與中間產物；--all 連 src-tauri/vendor、node_modules 一併清
cargo xtask push -m "訊息"         # commit 所有變更並推送到 GitHub；不帶 -m 只推送已 commit 的內容
cargo xtask version                # 目前版本、依 commit 建議的下個版本與 release 指令
cargo xtask release 0.2.1          # 也接受 patch / minor / major；--install 同時安裝，-y 略過確認
```

Cargo 輸出預設放在 `/private/tmp/highostty-target`（可用 `CARGO_TARGET_DIR` 覆寫），dmg 輸出在 `release/bundle/dmg/`。版本號以 `package.json` 為準，`tauri.conf.json` 直接引用；release 會同步 `src-tauri/Cargo.toml` 與兩個 lock 檔。release 需要乾淨的工作目錄、位於 `main` 且與遠端同步，以及已登入的 `gh`；建置失敗時會還原版本號。第一次 `push` 會建立 git repo 並接上遠端既有歷史。

## 共用 Ghostty 設定

使用 Ghostty 原生解析器載入現有設定，包含主題與遞迴 `config-file`。不建立副本，也不改写使用者設定。設定按鈕會顯示共用檔案位置及診斷，提供開啟設定檔和重新載入。

字型、字級、顏色、游標、shell、scrollback、shell integration、custom shader 等由 Ghostty 原生引擎處理。視窗及快捷鍵由宿主橋接：新視窗、頁籤、分割、搜尋、全螢幕、裝飾、透明度、快速終端及全域快捷鍵。Ghostty 設定優先於 HiGhostty 的 ⌘O 預設快捷鍵。

原生引擎與原版 macOS 應用的宿主功能仍需區分：目前尚未提供原版 Inspector 與自動更新器；遇到未實作的宿主 action 會提示，不會靜默假裝套用。GTK 等其他平台設定不適用。

全域快捷鍵使用 macOS event tap，需要使用者授予 HiGhostty「輔助使用」權限。權限不足會提示；允許後重新載入設定。原版 Ghostty 若同時使用同一個全域快捷鍵，可能競爭事件，請在兩個應用之間避免重複註冊。

## 檔案預覽窗

- 每個頁籤可在終端機右側或下方開一個預覽窗（Markdown 排版、純文字、圖片），檔案被改動時自動更新，適合邊看 agent 寫的計畫邊討論。從檔案面板右鍵「在預覽窗開啟」或指令選單開啟，預設在下方，可拖曳調整大小、切換左右／上下、彈出成獨立視窗（也能再放回頁籤）。
- agent 也能用 `highostty ctl preview open <檔案>` 自己打開（唯讀模式即可用），安裝 skill 後 agent 會知道這個功能。詳見 `docs/preview.md`。

## 檔案面板與工作區

- 標題列為 macOS 視窗控制鈕保留左側空間；標題文字不可反白選取，拖曳標題區可移動視窗。
- 左側操作區由 Icon Rail、第一層 Drawer 與第二層 Drawer 組成；工作區、收藏及設定從 Rail 開啟，Drawer 展開時會推擠終端機。Drawer 面板狀態會保存，收藏群組內容與編輯頁顯示在第二層。
- 每個頁籤各有一個檔案面板，用視窗右上角的資料夾按鈕開關，或按 ⌘O（字母 O）或 ⌘0 開啟並聚焦、再按一次關閉；預設在終端機右側（可拖曳調寬），⇧⌘F 或標題列按鈕切換滿版。面板開合與滿版狀態隨頁籤（含收藏）保存。
- 面板跟隨聚焦終端機的 `cd`；在面板中瀏覽到別處時暫停跟隨，按「回到終端機目前目錄」恢復。
- 可切換「清單」與「三欄」兩種檢視。清單可展開子資料夾、依名稱／大小／修改日期排序；三欄是「上層｜目前｜預覽」，預覽欄顯示資料夾內容或檔案縮圖與資訊。兩者都能顯示隱藏檔。操作方式比照 Finder：⌘／⇧ 多選、空白鍵 Quick Look、Enter 重新命名、⌘C／⌘X／⌘V、⌘D 複製一份、⌘⌫ 丟到垃圾桶、⇧⌘N 新增資料夾、⌘↓ 開啟、⌘↑ 上層。
- 複製、剪下、貼上使用系統剪貼簿，可和 Finder 互相貼上；貼到文字處（包括終端機）時是加上引號的路徑。同名時自動改名（「名稱 2」、「名稱 副本」）。刪除一律丟到垃圾桶。
- 右鍵選單提供打開、打開方式、在終端機中編輯（在右側分割執行 `$EDITOR`）、插入路徑到終端機、拷貝路徑、在新頁籤開啟終端機、在 Finder 中顯示等。從 Finder 拖檔案到面板會複製進該資料夾。
- 沒有開啟中的頁籤時，「選擇資料夾…」呼叫 macOS 原生挑選器並在該處開啟終端機。詳細設計見 `docs/files-panel.md`。
- 將目錄拖入終端機區域可直接建立終端頁籤；拖入收藏可建立該目錄收藏。將檔案或目錄拖進終端會貼入 shell 路徑，不會自動執行。
- `cd` 後，頁籤與檔案面板立即跟隨目前聚焦的終端機。使用原生工作目錄事件；shell integration 關閉時，以每秒一次的輕量 cwd syscall 補足。
- 群組是收藏的上層，用來整理收藏；收藏可以不屬於任何群組。群組可設定名稱與顏色，點群組會在第二層列出其中的收藏，並可「全部開啟」。刪除群組時，其中的收藏會移到未分組。
- 終端機裡的 agent 可以用 `highostty ctl` 讀取其他頁籤與視窗、在背景頁籤執行並等待輸出、通知使用者、顯示檔案、新增指令片段、啟動並指揮其他 agent。預設唯讀，可在設定頁關閉或改為完整；`skills/highostty/SKILL.md` 教 agent 使用這些指令，設定頁可一鍵安裝到 Claude Code、Codex、GitHub Copilot、Gemini CLI（也能移除）。詳細設計與驗收見 `docs/agent-control.md`。
- 收藏保存單一頁籤的名稱、群組、啟動命令、tmux 選項、目錄與分割布局，是這些欄位唯一的一份；從工作區任何一列（含尚未開啟的）都能開啟收藏編輯頁修改，名稱與 tmux 狀態列立即套用到已開啟的頁籤，命令與 tmux 開關於下次開啟生效。分割布局與檔案面板開關是執行期狀態，只有在編輯頁按「以目前版面更新收藏」才會寫入。點收藏會切換至已開啟的頁籤，也可另開一份。收藏與群組都可拖曳排序，收藏可拖入群組或移回未分組。
- 工作區列出開啟中的頁籤，並在群組中補上尚未開啟的收藏：未分組頁籤在上方，分隔線下依群組分區並以群組顏色標示。群組色圓點或外框表示已有開啟頁籤，灰色空心圓點表示尚未開啟；點擊尚未開啟的收藏會開啟終端機。頁籤的名稱與群組由它來自的收藏決定（雙擊改名會改收藏名稱）；拖曳只在同一區內排序。頁籤可包含多個分割終端機，雙擊名稱可設定別名。
- 舊版的「群組收藏」（多個頁籤的快照）會在首次讀取時拆成一個群組及各頁籤收藏；舊工作階段中工作區頁籤的群組歸屬不再使用。
- 頁籤啟動命令僅作用於該頁籤的主要終端；可選擇直接執行，或先載入 Ghostty 設定的互動 shell 再執行，命令結束後保留 shell。此選項會隨頁籤快照與收藏保存。收藏多視窗共享，寫入後通知其他視窗更新。
- ⌘1～⌘9 切換前九個工作區頁籤（頁籤列右側顯示對應熱鍵；滑過時同位置出現「⋯」，或按右鍵，可重新命名、編輯、關閉）；⌘⇧B 開合側欄（收合時 rail 旁會留一排頁籤編號列，顯示 ⌘1～⌘9 與待處理狀態，點了直接切換，可用 rail 底部按鈕關閉）；⌘O 或 ⌘0 開關檔案面板。
- ⌘T 新頁籤、⌘⇧T 同目錄再開一個終端機（側欄顯示為原頁籤下的一層子項）、⌘D 向右分割、⌘⇧D 向下分割、⌘W 關閉目前 surface，遵從共用 Ghostty 快捷鍵設定。
- 啟動參數：`highostty --tab <收藏名稱或ID>`（可重複）開啟指定收藏頁籤，`--dir <目錄>`（可重複）開啟指定目錄的新頁籤；也可寫成 `--tab=名稱`。預設不開新實例：若已有 HiGhostty 在執行（且「agent 控制指令」未關閉），參數轉交給它並立刻結束；沒有執行中的實例就正常啟動，在還原 session 後開啟。加 `--new` 強制開新實例。`highostty --list-tabs` 列出所有收藏（名稱與 ID，以 Tab 分隔）；收藏編輯頁也有可複製的啟動參數。找不到的收藏會顯示提示。
- 關閉視窗時只要仍有頁籤開啟，一律詢問「不離開」或「全部強制退出」；關閉工作區或從應用選單結束時，先檢查工作；確認後清理程序並等待引擎回收 shell。PID 配合啟動時間核對，避免誤殺重用的 PID。

統一收藏儲存在 `workspace-favorites-v2.json`；既有 `favorites.json` 與 `group-favorites.json` 會在首次讀取時遷移，舊檔保留。`HIGHOSTTY_DATA_DIR` 可將開發／測試資料隔離到其他目錄。舊終端程序不會跨版本恢復；「復原關閉」建立相同目錄的新 shell，不恢復已終止的工作。

刻意 daemonize 並脫離終端 session／父子關係的程序無法保證找回。這個清理流程不是程序沙箱。

## 多國語系

設定頁「語言」可指定介面語系（預設跟隨系統，沒有對應語系檔時用英文）；內建 English 與繁體中文，語系檔可匯入／匯出，也能在 App 內編輯。使用者語系檔放在資料目錄的 `locales/`。細節見 `docs/i18n.md`。

## 檢查

```sh
npm test
npm run build
CARGO_TARGET_DIR=/private/tmp/highostty-target cargo test --manifest-path src-tauri/Cargo.toml
```

分割模型測試涵蓋拆分、移除、幾何配置、方向切換與尺寸限制；Rust 測試涵蓋家目錄與相對路徑展開。互動驗收清單在 `docs/verification.md`，完成與未完成的項目分開記錄。
