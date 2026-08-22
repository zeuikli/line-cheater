# LINE Cheater

LINE Cheater 是用來瀏覽、搜尋、整理與瘦身 iOS LINE App Container 備份的本機工具，提供桌面版、網頁版與 CLI。

- **下載與使用：** <https://line-cheater.gginin.de>
- **完整使用教學：**<https://hiraku.dev/2026/07/8187/>

## 建議使用順序

| 順序 | 工具 | 適合情況 |
|---|---|---|
| 1 | **桌面版** | 一般使用、大型備份、附件清理與建立可還原候選檔。 |
| 2 | **網頁版** | 免安裝快速查看、搜尋、匯出與附件審核。 |
| 3 | **CLI** | 批次分析、大型索引、差異比較、自動化或進階除錯。 |

桌面版是首選。它以 Rust 原生核心處理 `.imazingapp` 或解開的備份資料夾，適合長時間工作與大量附件，記憶體使用不會隨備份大小等比例增加。

## 桌面版

目前提供：

- macOS 12+：Apple Silicon `arm64`、Intel `x64`
- Windows 10/11：`x64`

### 使用方式

1. 從首頁或 [GitHub Releases](https://github.com/zeuikli/line-cheater/releases) 下載桌面版。
2. 優先選擇完整的 `.imazingapp`；也可選擇解開的 LINE 備份資料夾。
3. 若歡迎頁顯示「已分析的 Session」，可直接核對原始 `LINE.imazingapp` 路徑並載入既有 catalog；桌面版會先驗證來源檔案、大小／修改時間指紋、Session 版本與分析完成狀態，避免在開啟時重新雜湊整份大型備份。建立候選檔前仍會執行完整內容驗證。沒有可用 Session 時，再等待桌面版建立本機 catalog。第一次搜尋訊息時會建立工作目錄中的 FTS5 索引，畫面會顯示建立進度。
4. 瀏覽聊天室與訊息，或進入附件清理、完全相同附件審核及進階模式。
5. 查看必要的清理安全檢查與保守／平衡／積極方案預演；選擇方案後會回到全部附件、第 1 頁並收合預演卡片，再由分類卡聚焦複核範圍。需要改方案時按「變更方案」。只有阻擋候選檔建立的盲點才會在主畫面展開。
6. 通過還原前檢查問答後，另存新的 `.imazingapp` 候選檔。
7. 使用 iMazing 的 **Manage Apps → Restore App Data** 還原，並驗證聊天室、圖片與 SQLite。

桌面版支援：

- macOS／Windows 本機 LINE 快取模式：啟動時先要求 LINE 完全退出，只掃描固定 allowlist 內的可重建快取，刪除前再次驗證程序、路徑與檔案指紋，並移到系統垃圾桶而非永久刪除
- 本機快取模式不會修改加密的桌面聊天 `.edb`、帳號設定或未知檔案；也不會宣稱已刪除 LINE 雲端、手機或聊天對象的副本。LINE 沒有提供 consumer desktop chat 的官方 authenticated deletion API，因此遠端刪除選項保持停用，快取日後可能重新下載
- 聊天室與訊息瀏覽、搜尋、圖片預覽
- 自動列出完整且來源未變更的分析 Session，同時顯示原始備份與 Session 資料夾路徑，並直接重用附件及 SQLite 關聯索引
- 附件分類、篩選、原圖／縮圖個別標記；聊天室會顯示實際保留的縮圖數量，縮圖保留與批次刪除同時啟用時會明確顯示為刪除其他附件；分類批次刪除允許單一聊天室退出而不影響同分類的其他聊天室
- 清理安全檢查：SQLite 完整性、來源索引新鮮度、掃描狀態、WAL／SHM、未引用與不明附件；非阻擋提醒不佔用主工作區，只有阻擋項目需要處理時才展開
- 可選擇的保守／平衡／積極清理方案預演：三者選取後都先顯示完整附件範圍；保守方案可套用安全自動標記，平衡方案聚焦 SQLite 未引用清單，積極方案聚焦 SQLite 未引用與無法確認清單，人工複核不會自動標記
- 手動、自動與聊天室清理計畫分開記錄，可獨立清除手動標記
- Native core 仍保留有界的清理活動紀錄與可重現計畫指紋，桌面主清理畫面只保留標記、方案與候選檔建立所需的操作
- 建立候選檔後顯示 CRC、保留檔、SQLite 重寫、輸出數量與警告驗證報告
- 完全相同附件掃描與安全保留一份
- 大型備份的有界記憶體處理與可續跑工作
- FTS5 訊息搜尋與可觀察的首次索引進度；一般載入時的「正在比對 SQLite」是附件脈絡索引，不是 FTS5，且索引已建立後不會在每次搜尋重做完整來源內容驗證
- 聊天室與清理相簿的圖片採視窗附近才載入，維持最多四個並行預覽請求，減少初次開啟等待
- 依 CPU／實體記憶體自動調整 SQLite cache、mmap 與平行封存驗證 worker
- 進階移除指定聊天室、空聊天室、僅系統訊息聊天室及孤立 `LineSquare` 訊息
- 在新建候選檔內重寫 SQLite、執行 `VACUUM`，並串流建立 ZIP64 `.imazingapp`
- 若重寫時確認 `LineSquare.sqlite` 已損壞，桌面版會先停止並詢問是否重建；只有使用者選擇「重建並繼續」後，候選檔才會以可讀 schema 重建空白社群資料庫。完成報告會顯示資料未保留警告，原始備份不會被修改。此容錯不套用至保存重要聊天的 `Line.sqlite`

桌面版產生的候選檔已成功通過實際 iMazing 流程還原到手機，還原後可正常開啟 LINE。
建立候選檔前會要求確認：原始備份已保留、會在安全環境測試還原，以及還原後會驗證聊天室、圖片與 SQLite。來源備份始終以唯讀方式處理。

## 網頁版

網頁版適合快速查看與一般大小的備份，不需安裝；它也是手機上最輕量、不需商店帳號的使用方式。SQL 解析核心會隨網站一併快取，不依賴第三方 CDN。

1. 開啟 <https://line-cheater.gginin.de>。
2. 選擇來源：
   - **完整 LINE 備份**：支援附件索引、圖片預覽與附件整理。
   - **只讀訊息**：只選取 `Messages/Line.sqlite`。
   - **大型備份索引**：載入 Python CLI 產生的 `line-reader-index`。
3. 瀏覽、搜尋或匯出 HTML、JSON 與附件清單。

在手機上可將網頁版加入主畫面：

- iPhone／iPad：用 Safari 開啟後，點「分享」→「加入主畫面」。
- Android：用 Chrome 開啟後，點選單→「安裝應用程式」或「加到主畫面」。
- 先從電腦把 `Line.sqlite` 或 CLI 索引傳到手機的「檔案」或下載資料夾，再由網頁版選取。

手機的沙盒不允許網頁版或第三方 App 直接讀取 LINE 的私有容器，因此手機版能做查看、搜尋與匯出，不能自動關閉 LINE、掃描 LINE 目錄或直接刪除 LINE 正在使用的檔案。這些動作只在桌面版提供。

`Line.sqlite` 的典型位置：

```text
Container/AppGroups/group.com.linecorp.line/Library/Application Support/
PrivateStore/P_<account-id>/Messages/Line.sqlite
```

若同時存在 `Line.sqlite-wal` 與 `Line.sqlite-shm`，請選擇完整備份模式。接近或超過 1 GB 的 SQLite 建議改用桌面版；需要在網頁查看時，先以 CLI 建立大型索引。

網頁版另提供完整性檢查、時間軸、Schema Explorer、SQLite 差異比較、附件 exact duplicate 掃描與進階搜尋。

## 附件瘦身規則

附件會交叉比對 `Line.sqlite`、`LineSquare.sqlite`、`UnifiedGroup.sqlite`、訊息 ID 與路徑中的聊天室 ID。

| 狀態 | 意義 | 處理方式 |
|---|---|---|
| `referenced` | 附件與 SQLite 訊息有可信對應 | 查看縮圖、傳送者、時間與摘要後決定。 |
| `unreferenced` | 路徑 ID 有效，但資料庫沒有對應訊息 | 人工確認後再標記。 |
| `unconfirmed` | 對應關係不足 | 預設保留。 |

「只保留縮圖」會保護所選範圍內的所有非空縮圖，不要求縮圖必須能與原圖或 SQLite 訊息配對。只有已確認為圖片、且能與非空縮圖安全配對的原檔會自動加入清理計畫；PDF、影片、空縮圖、缺少縮圖或無法確認類型的原檔不會因此額外標記。

「刪除所有附件」包含圖片原圖、縮圖、影片、PDF、語音與其他附件。若同一範圍同時啟用「只保留縮圖」，保留縮圖的規則優先：所有非空縮圖都會保留，其餘附件仍加入清理計畫。

清理標記會保留來源證據：

| 標記來源 | 意義 |
|---|---|
| `manual` | 使用者逐檔或逐群組手動標記。 |
| `automatic` | 安全規則標記的已確認圖片原檔。 |
| `chat` | 聊天室／資料庫清理計畫衍生的附件。 |

清理前檢查若發現 SQLite 不完整、catalog 過期、附件掃描或訊息脈絡索引未完成，候選檔建立會暫停；SQLite 未引用與無法確認的附件只會列為人工複核項目。

## CLI

### Python CLI

Python CLI 使用標準函式庫，適合 snapshot、health、index、search、timeline、schema、duplicates、diff、messages 與 `slim-test`。

```bash
python3 cli/line_migrator.py inspect \
  --source /path/to/line-backup \
  --format text

python3 cli/line_migrator.py snapshot \
  --source /path/to/line-backup \
  --out /path/to/line-work/snapshot

python3 cli/line_migrator.py health \
  --source /path/to/line-work/snapshot

python3 cli/line_migrator.py index \
  --snapshot /path/to/line-work/snapshot \
  --out /path/to/line-work/line-reader-index

python3 cli/line_migrator.py verify-index \
  --index /path/to/line-work/line-reader-index \
  --source /path/to/line-work/snapshot
```

詳細參數與大型備份流程請見 [CLI.md](CLI.md)。

### Rust CLI

Rust CLI 是 Electron 過渡版使用的 sidecar；Tauri 輕量版會直接連結同一個 Rust crate，兩者也可直接建置與執行：

```bash
cargo build -p line-cheater
```

架構、命令、資料合約與驗證紀錄請見 [NATIVE.md](NATIVE.md)。

## 資料安全

- 來源備份以唯讀方式開啟，所有候選檔與工作輸出另存。
- 網頁版不會把備份上傳到本站；顯示外部圖片或連結預覽時，瀏覽器可能連線至 LINE CDN 或原網站。
- 備份、候選檔、SQLite、索引與桌面版工作目錄都可能包含私人內容，請勿提交至 Git repository 或分享給第三方。
- 建議保留原始 `.imazingapp`，第一次先在測試裝置驗證還原結果。

## 開發桌面版

Tauri 2 是新的輕量共用殼層；Electron 暫時保留作為功能與發行回退：

```bash
npm --prefix native/tauri ci
npm --prefix native/tauri test
npm --prefix native/tauri run dev
```

macOS Tauri 封裝：

```bash
npm --prefix native/tauri run tauri build -- --bundles app,dmg
```

iOS 只接受系統檔案選擇器授權的備份，不會讀取 LINE 私有容器：

```bash
npm --prefix native/tauri run mobile:ios:init
npm --prefix native/tauri run tauri ios build -- --debug --target aarch64-sim --no-sign --ci
# 沒有 Apple Distribution：產生可由個人 Apple ID 簽署側載的 Release IPA
npm --prefix native/tauri run mobile:ios:unsigned
# Xcode 已登入 Apple Account 時，指定實機 Identifier 後直接安裝
npm --prefix native/tauri run mobile:ios:device -- <DEVICE_IDENTIFIER>
```

未簽署 IPA 的驗證、Xcode Personal Team 與個人側載步驟見
[沒有 Apple Distribution 時的 iOS 使用方式](docs/ios-without-distribution.md)。

Android 需先依 Tauri 文件安裝 Android SDK、NDK、Platform Tools 與四個 Rust Android targets：

```bash
npm --prefix native/tauri run mobile:android:init
npm --prefix native/tauri run tauri android build -- --debug --apk
```

手機商店正式發佈仍需 Apple Developer／Google Play 帳號、簽署材料、商店資訊與上傳授權；目前的驗證狀態見 [手機發行狀態](docs/mobile-release-status.md)。

Electron 回退版：

```bash
cargo build -p line-cheater
npm --prefix native/electron ci
npm --prefix native/electron test
npm --prefix native/electron run dev
```

macOS 封裝：

```bash
native/electron/scripts/package-dmg.sh
```

macOS Release 會分別建立 arm64／x64 DMG，執行 Developer ID 簽署、Apple notarization 與 ticket stapling。Windows Release 會建立 x64 ZIP，目前未配置 Windows code signing。詳細流程請見 [Electron package 說明](native/electron/README.md#macos-package)。

## 限制

- 不建議把超大 SQLite 直接載入網頁版；優先使用桌面版或 CLI 索引模式。
- 桌面版搜尋優先使用工作目錄中的 FTS5 索引；不可用時會退回有界 `LIKE` 掃描。
- FTS5 索引第一次建立可能需要時間；請等待進度完成，之後同一來源的搜尋會直接重用索引。
- ZIP 媒體內容採串流處理，但 central directory metadata 仍會隨檔案數量增加。
- catalog、搜尋索引、重複檔案雜湊與候選檔建立支援取消；候選 ZIP 取消後會從頭重建。
- 已驗證的實際還原案例不代表所有 LINE、iOS、iMazing 版本與備份組合都會有相同行為。

## 其他文件

- [Python CLI](CLI.md)
- [原生核心架構與驗證紀錄](NATIVE.md)
- [Electron 開發、封裝與安全邊界](native/electron/README.md)
- [沒有 Apple Distribution 時的 iOS 使用方式](docs/ios-without-distribution.md)
- [Hiraku Dev：LINE 瘦身說明](https://hiraku.dev/2025/09/7802/)
- [iMazing：App Data 備份與還原](https://imazing.com/guides/how-to-export-backup-and-transfer-ios-apps-data-and-settings)
