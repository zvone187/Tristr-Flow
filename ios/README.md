# Tristr Flow for iOS

Sign in with the email and password for an existing Tristr Flow account. Paste a passage and tap **Read aloud**. The service generates speech against the account's credit balance. The reader highlights words as they play. Tap a generated word to seek using the buffered audio.

The app uses the same hosted service and accounts as the desktop app. It authenticates at `POST /api/auth/login`, saves the returned account token in the iOS Keychain, and uses it to check the account and request speech at `POST /api/tts`. The service holds the provider credentials. The iOS reader supports curated ElevenLabs voices and Fish Audio voices made available by the service. Read-aloud requests and voice previews both use account credits. An insufficient balance stops the request and leaves the account signed in. Signing out removes the saved session from this device. [Hosted Tristr Flow service](https://tristr-flow-5iy7.onrender.com)

## Run the app and tests

Open `TristrFlow.xcodeproj` in Xcode and select the `TristrFlow` scheme. The deployment target is iOS 17. The project is committed. Regenerate it with `xcodegen generate` from this directory after changing `project.yml`.

For a simulator test, run the following from the `ios` directory. Replace the simulator name with one installed in Xcode. The account and playback UI test runs against a local fixture service with recorded audio.

```sh
xcodebuild test -project TristrFlow.xcodeproj -scheme TristrFlow \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

## Install on an organization development device

The iPhone target uses automatic signing with **Pythagora Technologies Inc.** and the bundle ID `ai.pazi.tristrflow.ios`. This identifier installs alongside the original personal copy (`ai.pazi.tristrflow`). Open the organization build and sign in. Each app has its own local settings and Keychain access.

To build in Xcode, select the connected iPhone as the run destination. The Mac must be signed in to the organization team, and Developer Mode must be enabled on the phone. For an equivalent Release installation from this directory, first run `xcodebuild -project TristrFlow.xcodeproj -scheme TristrFlow -showdestinations` and set `IPHONE_UDID` to the physical device ID it lists.

```sh
xcodebuild -project TristrFlow.xcodeproj -scheme TristrFlow -configuration Release \
  -destination "platform=iOS,id=${IPHONE_UDID:?Set IPHONE_UDID first}" \
  -derivedDataPath build/device -allowProvisioningUpdates build
xcrun devicectl device install app --device "$IPHONE_UDID" \
  build/device/Build/Products/Release-iphoneos/TristrFlow.app
xcrun devicectl device process launch --device "$IPHONE_UDID" ai.pazi.tristrflow.ios
```

The organization profile created on November 8, 2026 covers the registered iPhone through November 8, 2027. Each build uses the expiration date in its own embedded profile. Before that date, install a fresh organization build or the released App Store version. Customers installing from the App Store do not need a development profile. [Apple certificate and distribution guidance](https://developer.apple.com/help/account/certificates/certificates-overview/)

## Distribute to customers

1. In the organization's Apple Developer account, confirm an explicit iOS identifier for `ai.pazi.tristrflow.ios`. In App Store Connect, select its existing iOS app record or create one for that identifier. A development build may use a wildcard profile, so successful device installation alone does not verify a store record. [Create an app record](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/)
2. Give each upload a new build number in `project.yml`, regenerate the project, and archive the Release scheme. In Xcode Organizer, validate the archive and select **Distribute App > App Store Connect** to upload it. For a local distribution package, use the commands below. Exporting requires access to the organization's Apple Distribution signing assets and a matching store profile. [Upload builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)
3. For beta testing, assign the processed build to a TestFlight group. External testing of the first build requires Beta App Review. Each TestFlight build expires after 90 days. For ongoing customer installation, add the build to an App Store version and submit that version for App Review. [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/) · [App Store Connect workflow](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-workflow/)
4. For App Review, provide a dedicated, working demo account with enough speech credits to test reading, plus instructions to paste a passage, play, pause and seek. Put the credentials in the private review information and keep production speech available during review. In the review notes, explain how customer accounts acquire and consume credits and assess the intended purchase model under the applicable storefront rules. [App Review](https://developer.apple.com/app-store/review/) · [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
5. Complete the store description, device screenshots, age rating, and a public support URL with a working contact. Provide the privacy policy in the app and store listing, and complete the privacy declarations for the actual iOS client, backend and speech providers. Open the support and privacy links from a clean browser before submission. Confirm that the published policy covers submitted iOS text, account details, credit usage, and provider processing. The existing service policy initially described the Mac app. [Tristr Flow privacy policy](https://tristr-flow-5iy7.onrender.com/privacy) · [Apple's app privacy information](https://developer.apple.com/help/app-store-connect/reference/app-information/app-privacy/)

Run these commands from the `ios` directory to create the archive and export an IPA locally.

```sh
xcodebuild archive -project TristrFlow.xcodeproj -scheme TristrFlow -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/TristrFlow.xcarchive \
  -allowProvisioningUpdates
xcodebuild -exportArchive -archivePath build/TristrFlow.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath build/app-store \
  -allowProvisioningUpdates
```
