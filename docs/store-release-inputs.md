# LINE Cheater 手機版上架交接清單

## iOS / TestFlight / App Store

目前本機只有 `Apple Development` 憑證，沒有可上架用的 Distribution 憑證或
provisioning profile。要繼續上傳，需要：

- 有效的 Apple Developer Program 團隊與 App Store Connect 權限。
- 在該團隊註冊 bundle ID `de.gginin.line-cheater`，或提供要改用的新 bundle ID。
- Apple Distribution 憑證與 App Store provisioning profile；也可由有權限的 Xcode
  帳號自動管理簽署。
- App Store Connect 的 App 記錄、SKU、主要語言、販售地區、年齡分級、支援網址與
  隱私權政策網址。
- App Privacy 問卷答案與審核聯絡資料。
- 明確授權將簽署後的 archive 上傳到 App Store Connect。

## Android / Google Play

目前本機沒有 Android SDK，也沒有 Play Console 或簽署資料。要繼續上傳，需要：

- Google Play Console 中的 App 記錄與 package name（預設對應
  `de.gginin.line_cheater`，正式建立前需確認）。
- Play App Signing 設定，以及 upload keystore、alias 和密碼；密碼只放在 CI secret，
  不寫入 Git。
- Google Play service account 或由具發布權限的人員手動上傳。
- 商店名稱、短／長說明、圖示、手機與平板截圖、分類、聯絡方式、隱私權政策網址、
  Data safety 與 Content rating 問卷答案。
- 明確授權將簽署後的 AAB 上傳到 Internal testing 或指定軌道。

## 已完成、可直接沿用

- iOS Simulator arm64 App 已建置、安裝與啟動驗證。
- 不需要 Distribution 的 iPhoneOS arm64 Release IPA 已產出並驗證；可由 Xcode Personal
  Team 或 AltStore Classic 使用個人 Apple ID 簽署側載。詳見 `docs/ios-without-distribution.md`。
- GitHub Actions 已成功產出 iOS Simulator App、22,049,312-byte 的 arm64 Android Release
  側載 APK、macOS DMG 與 5,036,699-byte 的 Windows NSIS。Android 測試包已由一次性 CI
  身分簽署，並通過 APK Signature v2/v3 驗證；正式上架仍須換成擁有者保管的固定金鑰。
- macOS arm64 DMG 已以 ad-hoc 簽署並通過 `codesign --strict` 與 `hdiutil verify`。
- 手機版只讀取使用者在系統檔案選擇器明確選取的備份，不會也不能讀取 LINE 的私有
  App 容器。
- 本機清理或重寫備份不代表 LINE 雲端刪除；LINE 沒有提供可供本工具使用的官方消費者
  雲端刪除 API。
