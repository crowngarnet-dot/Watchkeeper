# Watchkeeper

Voice-driven reminders for meetings and follow-ups. Two ways to run it:

| | Web app (GitHub Pages) | Android app (APK) |
|---|---|---|
| Alarms with the phone locked | No | **Yes** |
| Survives a restart | No | **Yes** |
| Voice entry and confirmation | Yes (needs a connection) | Yes (works offline) |
| Where the data lives | That browser only | That phone only |

Both run the same interface. The Android app is the one that rings when the
phone is locked.

## Files

    index.html      the whole interface
    core.js         time zones, parsing, recurrence, storage
    voice.js        speech grammar and phrasing
    native.js       bridge to Android; inert in a browser
    sw.js           service worker (web only)
    android/        the Android project
    .github/workflows/android.yml   builds the APK

## Web app

Push `index.html`, `core.js`, `voice.js`, `native.js` and `sw.js` to the repo
root. GitHub Pages serves them. HTTPS is required for the microphone, which
the `github.io` address already provides.

## Android app

Nothing to install on your computer. GitHub builds it.

1. Commit the `android/` folder and `.github/workflows/android.yml`.
2. Open the **Actions** tab. The build starts on its own; it takes 3-5 minutes.
   If it does not start, open **Build Android APK** and press **Run workflow**.
3. When it finishes, open **Releases** on the repository front page. The newest
   release has a `.apk` file attached.
4. On the phone, open that release page in Chrome and tap the `.apk`.
   Android asks whether to allow installing from Chrome — allow it.
   Play Protect will warn about an unknown developer; choose **Install anyway**.
   That warning is because the app is signed with the standard debug key rather
   than a paid Play Store identity, not because anything is wrong with it.
5. On first launch, allow the microphone and notifications.

Every later push rebuilds and publishes a new release. To update the app,
download the newer APK and install over the top; reminders are kept.

### If alarms are late

Android settings -> Apps -> Watchkeeper -> **Alarms & reminders** -> allow.
The app's own status panel (the menu button) says whether this is on.

## Building the APK on your own machine instead

Needs JDK 17 and the Android SDK.

    cp index.html core.js voice.js native.js android/app/src/main/assets/www/
    cd android && gradle assembleDebug

The APK lands in `android/app/build/outputs/apk/debug/`.

## What is not here

No server, no account, no analytics, no network calls of its own. Reminders
never leave the device. Speech recognition uses the phone's own engine, which
works offline once the language pack is installed; Chrome's web speech sends
audio to Google, which is one more reason to prefer the app.
