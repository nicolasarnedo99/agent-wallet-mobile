# agent-wallet-mobile

A small TypeScript client that logs in to a Circle Agent Wallet and signs with it from a React Native app, with no CLI on the device and no server in between. It also runs in Node.

**Unofficial.** This project is not affiliated with, sponsored by or endorsed by Circle. It talks to the same backend that Circle's own CLI (`@circle-fin/cli` 1.4.0) talks to, an API Circle has not documented for outside use and can change at any time. Read [Known gaps](#known-gaps) before relying on it for anything.

The code is lifted out of Nest, an iPhone app where it paid for x402 resources from an agent wallet on Arc testnet. This package is that client on its own, with logout added and the app taken away. Its tests run against a stand-in for Circle's proxy. The built package has also run against Circle itself, from Node on Arc testnet: a login, a payment, a contract call and a logout (see the end of [Known gaps](#known-gaps)).

## Quick start

It is not on npm. Install it from a checkout (`npm install ../agent-wallet-mobile` after `npm run build`), together with `viem`, and in React Native `react-native-keychain` and `react-native-get-random-values`.

```ts
import 'react-native-get-random-values';
import * as Keychain from 'react-native-keychain';
import { createAgentWallet, keychainStorage } from 'agent-wallet-mobile';

const agent = createAgentWallet({ network: 'arc', storage: keychainStorage(Keychain) });

// Log in. Circle emails a code that reads "ABC-123456"; the six digits are enough.
await agent.login.prepare();          // optional: start making the login key early, it takes seconds on a phone
await agent.login.start(email);
const wallet = await agent.login.finish(code);   // { address, id, blockchain, network, expiresAt }

await agent.balance();                // "19.99", USDC as Circle reports it

// Sign EIP-712 typed data: as a viem account, or as the signer @x402/evm asks for.
const account = await agent.account();
const signature = await account.signTypedData({ domain, types, primaryType, message });
registerExactEvmScheme(x402client, { signer: await agent.x402Signer() });

// Send one contract call. Circle's bundler submits it; the promise resolves once Circle reports it confirmed.
const { hash } = await agent.call({ to: contract, data: calldata });

await agent.logout();                 // revoke this session at Circle; logout('all') revokes every device's
```

On the next launch, `createAgentWallet` with the same storage finds the session again: `agent.wallet()` answers without a network call, and throws an `AgentWalletError` with code `not_logged_in` or `session_expired` when there is nothing to use. `agent.session()` returns the stored session itself, and `isExpired(session)` says whether it is past its expiry.

Every failure is an `AgentWalletError` with a `code`: `not_logged_in`, `session_expired`, `needs_cli_bootstrap`, `wrong_code`, `invalid_input`, `http` (with Circle's `status`), `protocol` (Circle answered with something this client does not understand) or `transaction_failed`.

[`examples/expo-app`](examples/expo-app) has a one-screen app (log in, balance, pay one x402 resource). It builds and installs on an iPhone, and has not yet logged in or paid from one. Its payment helper, `x402.ts`, is the part the tests and the smoke script exercise.

## Security model

An agent wallet's key is split in two shares, both held by Circle (two-of-two MPC). Circle's terms say the shares "can only be invoked for signing with the user's secret credential". In practice that credential is a user secret Circle hands the client at login. For each signature Circle opens a challenge; the client approves it with a PIN hash derived from that secret and a share that comes with the challenge, encrypted to a key in the challenge. Nobody types a PIN. So the device approves every signature, but the device holds no key material of its own.

That makes the session a bearer credential. It is five values (`userToken`, `encryptionKey`, the sealed user secret, its `storageKey`, and a `deviceId` the client made up), and whoever holds them can sign for the wallet until the token expires. Nothing binds them to the device: no device key, no attestation. This is why the session belongs in the Keychain and nowhere else. `keychainStorage` stores it as `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so it is unreadable while the phone is locked and is never copied into a backup or onto another device. `memoryStorage`, the default, keeps it for the life of the process only. Do not write a session to a file, AsyncStorage or a log.

The library never stores, logs or returns the email or the code. The email lives in memory between `login.start` and `login.finish`; the code goes into one encrypted request. Errors carry Circle's HTTP status and numeric code, and Circle's own message only outside a login, where it could echo either.

Circle signs whatever typed data a valid session sends, and I found no spending limit applied on testnet. Whatever limit you want has to run in your app before `signTypedData` is called. `examples/expo-app/x402.ts` shows the shape: the 402's scheme, network, token, amount and payee are checked against what the app expects, and a 402 that fails sends nothing to Circle. The tests cover that refusal.

Two smaller points. The wallet is a smart contract account, so its signatures verify through ERC-1271 rather than `ecrecover`, and only once the wallet is deployed; a new wallet needs one first transaction of any kind before a seller's facilitator will accept its signature. And requests go out with the runtime's own User-Agent. The library never claims to be Circle's CLI, and if Circle's proxy starts refusing other clients, that is a stop, not something to work around.

Circle's Agent Platform terms apply to whoever logs in: it is your account, on your device. Don't ship an app in which other people use your session.

## Networks

| `network` | Chain | Circle environment | USDC |
|---|---|---|---|
| `arc` | Arc testnet (`ARC-TESTNET`, chain 5042002) | testnet proxy | `0x3600000000000000000000000000000000000000` |
| `base` | Base mainnet (`BASE`, chain 8453) | live proxy, real funds | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

Testnet and mainnet are separate Circle accounts with separate logins and wallets, so each needs its own `createAgentWallet` and its own emailed code. Other chains Circle supports would be a line each in `NETWORKS`; these two are the ones that were exercised.

## Known gaps

The API is undocumented. Every call was read out of the CLI's published source (see [docs/PROTOCOL.md](docs/PROTOCOL.md)), and a CLI release can change any of them without notice. Half the endpoints do appear in Circle's user-controlled wallets reference, but there they are called with your own API key; here Circle's proxy adds its own.

A session cannot be refreshed. The CLI never keeps a refresh token and neither does this client, so when the session expires (the `exp` of the user token) the user logs in again with a new code.

A new account's first login has to happen in Circle's CLI. That first login creates the wallets (Circle calls it bootstrap), and this client stops with `needs_cli_bootstrap` instead of doing it. Run `circle wallet login --testnet` (or without the flag for mainnet) once, then log in here. Accounts from before Circle's current login flow use an older path this client does not implement either.

It signs typed data and sends contract calls, and that is all: no `signMessage`, no raw transactions, no token-transfer shortcut, no spending policies, no Gateway. `call()` waits at most a minute for the approval and a minute for the transaction. A transaction that outlasts its minute throws with its id in the message, and `transaction(id)` reports where it stands.

Only an iPhone has run this code. Android goes through the same `react-native-keychain` call and should work, but nobody has tried. The approval request still carries the device description the CLI sends (`WebSDK`, `Desktop`), because that is the only value known to pass.

Making the RSA-2048 login key in pure JavaScript is slow: about 22 seconds in Node with the JIT off, used as a stand-in for a phone's engine. It was not timed on the iPhone. Call `login.prepare()` when the email field gets focus so the wait hides behind typing. The key is made in 50 ms slices with a `setTimeout` between them. That is deliberate: node-forge's own async generation chains `setImmediate`, which React Native 0.88 runs as a microtask, and the app froze until the key was done.

Last, what has and has not run for real. On 23 Nov 2026 the built package ran against Circle from Node on Arc testnet (`npm run smoke`): login, wallet, balance, one x402 payment, `call()`, `transaction()` and `logout('local')`, with both transactions checked on-chain and the old session refused afterwards. The hashes are in [docs/FOR-CIRCLE.md](docs/FOR-CIRCLE.md). On a phone, the login, balance and typed-data signing code ran from Nest on an iPhone, where it lived as one file; this package itself has only been built and installed there. Nothing from this package has run on Base mainnet, and `logout('all')` has never been sent to Circle.

## Development

```
npm install
npm test            # vitest, against a stand-in for Circle's proxy; no network
npm run typecheck
npm run build       # dist/
npm run smoke       # live, on Arc testnet: asks for your email and code, pays a seller of mine 0.01 USDC
```

The fake in `test/fake-circle.ts` is written with Node's own crypto from the CLI's source, so the library's AES, RSA and PIN code is checked against a second implementation rather than against itself. The library itself imports no Node built-ins.

## Licence

Apache-2.0. The protocol logic was ported from `@circle-fin/cli` (Apache-2.0, Circle Internet Group, Inc.); see [NOTICE](NOTICE).
