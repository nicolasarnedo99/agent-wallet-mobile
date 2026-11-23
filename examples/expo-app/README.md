# Example app

One screen: log in with the emailed code, read the USDC balance, pay one x402 resource 0.01 USDC on Arc testnet, log out. `x402.ts` holds the payment and the checks that run before Circle is asked to sign; `App.tsx` is the screen.

It needs its own build, not Expo Go, because `react-native-keychain` is a native module. The library comes from npm, as it would in any app.

```
cd examples/expo-app
npm install
```

Put the one seller the app may pay, and the address that seller is paid at, in `.env.local` (Expo reads it at build time, and git ignores it):

```
EXPO_PUBLIC_RESOURCE=https://seller.example/paid
EXPO_PUBLIC_PAY_TO=0x...
```

Change `ios.bundleIdentifier` in `app.json` to one of your own, then build for a connected iPhone. The build is a Release one, so the JavaScript is inside the app and no Metro server has to run:

```
APPLE_TEAM_ID=<your team id> npx expo prebuild --platform ios
xcodebuild -workspace ios/AgentWalletExample.xcworkspace -scheme AgentWalletExample -configuration Release \
  -destination id=<device id> -derivedDataPath build -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
xcrun devicectl device install app --device <device id> build/Build/Products/Release-iphoneos/AgentWalletExample.app
```

`babel.config.js` rewrites the one dynamic `import()` in `@x402/core`, which Hermes cannot compile and the phone never reaches.
