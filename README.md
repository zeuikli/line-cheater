# LINE 備份閱讀器｜GitHub Pages 部署包

這個資料夾包含可直接上傳到 GitHub Pages 的純前端版本，以及供本機使用的 CLI。GitHub Pages 只會發布 HTML／CSS／JavaScript，不會執行 `cli/`。

## 上傳方式

將本資料夾內的所有檔案放到 GitHub repository 的根目錄，或放到你設定給 GitHub Pages 的發布目錄。

不要把原始 LINE 備份資料夾、`Container`、`Payload`、SQLite 檔案或個人聊天內容放進 repository。

## 使用方式

LINE iOS App Container 備份檔案可透過 iMazing 備份軟體取得；本工具不會直接操作 iMazing，只讀取你選取的備份檔案。

### 1. 閱讀與匯出

1. 開啟 GitHub Pages 網址。
2. 選擇載入方式：
   - **完整 LINE 備份**：選取整個備份資料夾，可使用附件索引、圖片預覽與本機附件連結。
   - **只讀訊息**：只選取 `Messages/Line.sqlite`。完整路徑為：
     `Container/AppGroups/group.com.linecorp.line/Library/Application Support/PrivateStore/P_<account-id>/Messages/Line.sqlite`
     其中 `P_<account-id>` 是備份中實際存在的 `P_` 開頭資料夾。
3. 搜尋聊天室、閱讀訊息，或匯出 HTML／JSON／附件清單。
4. 若備份另有 `Line.sqlite-wal`／`Line.sqlite-shm`，建議使用完整備份模式，以降低遺漏最近資料的風險。

### 2. 附件瘦身

附件清單會先依 `Line.sqlite` 的訊息關聯分組，再讓你逐一檢查：

- **個人聊天室**：附件可對應到一對一聊天室。
- **群組聊天室**：附件可對應到群組聊天室。
- **社群**：附件可對應到社群／公開聊天室。
- **孤兒檔案**：檔名或內部識別資訊找不到目前 `Line.sqlite` 訊息關聯，必須人工確認後才能選取。

每筆附件會盡可能顯示縮圖、聊天室名稱、傳送者、傳送／接收時間、訊息內容摘要與「SQLite 已關聯／未引用」狀態。聊天室名稱優先讀取 `UnifiedGroup.sqlite` 的目前名稱，再使用 `ZGROUP` 或最新改名系統訊息；不使用成員名單拼接名稱。只有在完成脈絡確認後，才透過勾選框加入刪除計畫；未勾選的檔案預設保留。

附件瘦身區分為兩種輸出：

| 輸出 | 用途 | 安全狀態 |
|---|---|---|
| 瘦身操作計畫 | 匯出要移除的附件清單、容量與警告 | 可直接產生，原始檔不會變更 |
| `.imazingapp.candidate` | 以未標記檔案重新建立 ZIP 候選封裝 | 實驗性，尚未宣稱可還原 |

安全操作順序：

1. 永遠保留原始 `.imazingapp`，不要直接覆寫。
2. 在附件瘦身區依聊天室審核附件：先看聊天室名稱，再用縮圖、傳送者、時間與訊息摘要辨識內容。原始附件與縮圖可以分開勾選；未勾選檔案預設保留。
3. 優先只測試一個 `Message Thumbnails` 縮圖，不要第一輪刪除 `Message Attachments` 原始附件。
4. 使用「匯出瘦身操作計畫」保存 JSON／純文字清單。
5. 若要使用候選封裝，按下「建立 `.imazingapp` 候選封裝」，輸出檔名會以 `.imazingapp.candidate` 結尾。
6. 只在副本上將副檔名改回 `.imazingapp`，先於 iMazing 的 **Manage Apps → Restore App Data** 執行 dry-run。
7. 確認 iMazing 接受後，才使用測試裝置驗證；不要第一輪就在主力手機還原。

候選封裝限制：

- 只保留未標記的 `Container/`、`Payload/` 與必要根目錄檔案。
- `Messages/Line.sqlite` 若不在保留集合中，封裝會中止。
- 支援 File System Access API 的瀏覽器會直接寫入檔案；其他瀏覽器對大型輸出會阻止 Blob 下載，以避免記憶體峰值。
- 候選封裝會重新建立 ZIP，可能改變 ZIP metadata；目前沒有 iMazing 實機還原保證。
- 刪除縮圖通常只會移除預覽；刪除原始附件可能導致 LINE 無法開啟媒體。
- 部分舊附件在目前的 `Line.sqlite` 中已找不到對應訊息；介面仍會依路徑中的聊天室 ID 分組並顯示縮圖，但會明確標示「找不到對應訊息」，不會把檔案修改時間誤稱為傳送時間。
- JSON 與純文字操作計畫會附上可辨識的聊天室、訊息時間、傳送者與摘要，實際刪除目標仍以完整封存路徑為準。

目前已用原始 `.imazingapp` 的副本完成單一縮圖安全測試：只移除 1 個縮圖，原始檔未修改，`Line.sqlite`、`.lock` 與 `Payload/LINE.app/Info.plist` 的內容雜湊相同，ZIP CRC 驗證通過。這不等於已完成 iMazing 還原驗收。

參考：[Hiraku Dev 的 LINE 瘦身說明](https://hiraku.dev/2025/09/7802/)、[iMazing App Data 備份與還原說明](https://imazing.com/guides/how-to-export-backup-and-transfer-ios-apps-data-and-settings)。

### 3. 本機 CLI 與大型備份

完整命令、從完整備份到大型分片索引的建議流程、搜尋／差異／瘦身操作與安全限制，請看獨立文件：[CLI.md](CLI.md)。

簡化判斷：先在網頁讀完整備份做初步確認；需要批次或細部操作時使用 CLI。若 `Line.sqlite` 接近或超過瀏覽器安全記憶體門檻，直接使用 CLI 產生 `line-reader-index`，再回到網頁選取「大型備份索引」。

### 4. 隱私與網路

資料只會在目前瀏覽器分頁內解析，不會上傳到這個網站的伺服器。sql.js 與候選封裝使用的 fflate 由 jsDelivr 載入，因此首次使用需要網路連線；連結預覽圖片若來自 LINE CDN 或原網站，瀏覽器顯示圖片時也會向該圖片網址發出請求。
