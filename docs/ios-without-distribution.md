# 沒有 Apple Distribution 時的 iOS 使用方式

LINE Cheater 現在可產生不需要 Distribution 憑證的 iPhoneOS arm64 Release IPA。它不能直接
安裝；iOS 仍要求每個 App 由某個 Apple ID 簽署。可選以下兩種方式。

## 方法一：Xcode Personal Team（Apple 官方方式）

1. 在 Xcode 的 Settings > Accounts 登入自己的 Apple Account。
2. 保持 iPhone 已解鎖、信任這台 Mac，並開啟 Developer Mode。
3. 在專案目錄執行 `xcrun devicectl list devices`，複製要安裝手機的 Identifier。
4. 執行：

   `npm run mobile:ios:device --prefix native/tauri -- <DEVICE_IDENTIFIER>`

此流程會用 `Apple Development` 和 debugging provisioning profile 建置、安裝並啟動 App，
不需要 Apple Distribution。若使用免費 Personal Team，Apple 的描述檔通常七天到期，之後需
重新建置安裝。

目前這台 Mac 的 Xcode 尚未登入 Apple Account，所以已存在的 Development 憑證無法自動建立
`de.gginin.line-cheater` 的 provisioning profile；登入後才能完成這條流程。

## 方法二：使用個人 Apple ID 側載未簽署 IPA

已產出的 Release IPA：

`native/tauri/src-tauri/gen/apple/build/unsigned/LINE-Cheater-0.1.31-unsigned.ipa`

SHA-256：

`d12cc5f37767c460de392a061c1b99f102c87852f8f8cbc79b97c82d91bcacd5`

建議只從 [AltStore 官方網站](https://altstore.io/) 下載 AltServer。安裝 AltServer、連接並信任
iPhone 後，在 macOS 按住 Option 點 AltServer 選單，使用 `Sideload .ipa…` 選取上述 IPA。
AltServer 會以你的個人 Apple ID 簽署後安裝；免費帳號的 App 需要定期（通常七天）重新簽署。

不要把 Apple ID 密碼、二階段驗證碼、憑證或 provisioning profile 寫入 Git 或傳到本專案。
若不希望把帳號交給第三方工具，請使用上面的 Xcode Personal Team 官方方式。

## 重新產生 IPA

執行：

`npm run mobile:ios:unsigned --prefix native/tauri`

腳本會進行無簽署 Release 建置，封裝乾淨的 `Payload/LINE Cheater.app`，驗證 ZIP 完整性，
並在同一資料夾寫出 SHA-256 檔。此 IPA 是 arm64、最低 iOS 14.0，沒有包含 `__MACOSX`
資源分支或任何簽署私鑰。
