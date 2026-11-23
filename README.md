# agent-wallet-mobile

A small TypeScript client that logs in to a Circle Agent Wallet and signs with it from a React Native app, with no CLI on the device and no server in between. It also runs in Node.

**Unofficial.** This project is not affiliated with, sponsored by or endorsed by Circle. It talks to the same backend that Circle's own CLI (`@circle-fin/cli` 1.4.0) talks to, an API Circle has not documented for outside use and can change at any time. Read [Known gaps](#known-gaps) before relying on it for anything.

The code is lifted out of Nest, an iPhone app where it paid for x402 resources from an agent wallet on Arc testnet. This package is that client on its own, with logout added and the app taken away. Its tests run against a stand-in for Circle's proxy. The built package has also run against Circle itself, from Node on Arc testnet: a login, a payment, a contract call and a logout (see the end of [Known gaps](#known-gaps)).

## Quick start

It is not on npm. Install it from a checkout (`npm install ../agent-wallet-mobile` after `npm run build`), together with `viem`, and in React Native `react-native-keychain` and `react-native-get-random-values`.

```ts
import 'react-native-get-random-values';
import * as Keychain from 'react-native-keychain';
import { createAgentWallet, keychainStorage, searchServices } from 'agent-wallet-mobile';

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

// Send USDC (or another token, by its contract address), and top up from Circle's testnet faucet.
await agent.transfer({ to: recipient, amount: '0.01' });
await agent.fund();

// Paid services in Circle's Agent Marketplace. Public: it needs no login.
const services = await searchServices({ query: 'restaurants' });

await agent.logout();                 // revoke this session at Circle; logout('all') revokes every device's
```

On the next launch, `createAgentWallet` with the same storage finds the session again: `agent.wallet()` answers without a network call, and throws an `AgentWalletError` with code `not_logged_in` or `session_expired` when there is nothing to use. `agent.session()` returns the stored session itself, and `isExpired(session)` says whether it is past its expiry.

Every failure is an `AgentWalletError` with a `code`: `not_logged_in`, `session_expired`, `needs_cli_bootstrap`, `wrong_code`, `invalid_input`, `http` (with Circle's `status`), `protocol` (Circle answered with something this client does not understand), `transaction_failed` or `limit_exceeded` (Circle refused to sign because of the wallet's spending limit).

[`examples/expo-app`](examples/expo-app) has a one-screen app (log in, balance, pay one x402 resource). It builds and installs on an iPhone, and has not yet logged in or paid from one. Its payment helper, `x402.ts`, is the part the tests and the smoke script exercise.

## Security model

An agent wallet's key is split in two shares, both held by Circle (two-of-two MPC). Circle's terms say the shares "can only be invoked for signing with the user's secret credential". In practice that credential is a user secret Circle hands the client at login. For each signature Circle opens a challenge; the client approves it with a PIN hash derived from that secret and a share that comes with the challenge, encrypted to a key in the challenge. Nobody types a PIN. So the device approves every signature, but the device holds no key material of its own.

That makes the session a bearer credential. It is five values (`userToken`, `encryptionKey`, the sealed user secret, its `storageKey`, and a `deviceId` the client made up), and whoever holds them can sign for the wallet until the token expires. Nothing binds them to the device: no device key, no attestation. This is why the session belongs in the Keychain and nowhere else. `keychainStorage` stores it as `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so it is unreadable while the phone is locked and is never copied into a backup or onto another device. `memoryStorage`, the default, keeps it for the life of the process only. Do not write a session to a file, AsyncStorage or a log.

The library never stores, logs or returns the email or the code. The email lives in memory between `login.start` and `login.finish`; the code goes into one encrypted request. Errors carry Circle's HTTP status and numeric code, and Circle's own message only outside a login, where it could echo either.

On testnet Circle signs whatever typed data a valid session sends: its spending limits exist on mainnet only. There they do cover x402 payments. On Base mainnet, with a limit of 0.005 USDC per payment set through the CLI, Circle refused to sign a 0.01 USDC payment (a 400, "spend limit exceeded"), opened no challenge and moved no funds. That test was run from the Nest app's side on 24 Nov 2026, not from this package, which only maps the refusal to `limit_exceeded`. Setting limits is not in this client, so whatever limit you want on testnet, or beyond Circle's, has to run in your app before `signTypedData` is called. `examples/expo-app/x402.ts` shows the shape: the 402's scheme, network, token, amount and payee are checked against what the app expects, and a 402 that fails sends nothing to Circle. The tests cover that refusal.

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

A new account's first login creates its wallets (Circle calls it bootstrap). On Arc testnet this client now does that itself, but only against the stand-in so far: no brand-new account has logged in through it. On Base mainnet it still stops with `needs_cli_bootstrap`; run `circle wallet login` once, then log in here. Accounts from before Circle's current login flow use an older path this client does not implement either.

It signs typed data, sends contract calls and token transfers, asks the testnet faucet and searches the marketplace. It has no `signMessage`, no raw transactions, no Gateway, and it cannot read or set spending limits. `transfer()`, `fund()` and `searchServices()` are tested against the stand-in only: none has been sent to Circle from this package. `call()` waits at most a minute for the approval and a minute for the transaction. A transaction that outlasts its minute throws with its id in the message, and `transaction(id)` reports where it stands.

Only an iPhone has run this code. Android goes through the same `react-native-keychain` call and should work, but nobody has tried. The approval request still carries the device description the CLI sends (`WebSDK`, `Desktop`), because that is the only value known to pass.

Making the RSA-2048 login key in pure JavaScript is slow: about 22 seconds in Node with the JIT off, used as a stand-in for a phone's engine. It was not timed on the iPhone. Call `login.prepare()` when the email field gets focus so the wait hides behind typing. The key is made in 50 ms slices with a `setTimeout` between them. That is deliberate: node-forge's own async generation chains `setImmediate`, which React Native 0.88 runs as a microtask, and the app froze until the key was done.

Last, what has and has not run for real. On 23 Nov 2026 the built package ran against Circle from Node on Arc testnet (`npm run smoke`): login, wallet, balance, one x402 payment, `call()`, `transaction()` and `logout('local')`, with both transactions checked on-chain and the old session refused afterwards. The hashes are under [On-chain](#on-chain). On a phone, the login, balance and typed-data signing code ran from Nest on an iPhone, where it lived as one file; this package itself has only been built and installed there. Nothing from this package has run on Base mainnet, and `logout('all')` has never been sent to Circle.

## On-chain

Everything is from 23 Nov 2026, on one account: agent wallet `0x7286ec1ec69b477bba05ce28a21b1e03748b7765` on Arc testnet and `0xece745ef9d38a03473a5adafa6b71951170448d4` on Base mainnet. Each transaction was checked against the chain's RPC.

Sent by this package, run from Node against Circle's testnet proxy:

- An x402 payment of 0.01 USDC, signed through Circle and settled with the smart-account form of `transferWithAuthorization` (`0xcf092995`): [`0x4bb1e202…c51d`](https://explorer.testnet.arc.io/tx/0x4bb1e202471053a2303743172cec4395133d77998c0669c8b3f8767fb860c51d?tab=token_transfers)
- A contract call, a zero USDC `approve`, sent through EntryPoint v0.7 with the gas sponsored: [`0xe9cb7dd5…0ecb`](https://explorer.testnet.arc.io/tx/0xe9cb7dd52ad721be8c1c0aef6b1e61772921397d2098276e37157f814b4c0ecb)
- A logout, after which Circle's proxy answered the old session with 403.

Sent by an iPhone, from the same client while it still lived inside Nest:

- Two 0.01 USDC payments on Arc testnet: [`0xe65982f0…c803`](https://explorer.testnet.arc.io/tx/0xe65982f0a2548aac3df2fd9fccd46dcb681e330c0a4e8465261b7bf386d7c803?tab=token_transfers) and [`0x93e54e3e…b09e`](https://explorer.testnet.arc.io/tx/0x93e54e3e3b55f212e99954ba6c74183dfb170d2f908b4b708b58cc2e6264b09e?tab=token_transfers)
- 0.01 USDC on Base mainnet to Agentic Reservations, a seller from Circle's Agent Marketplace: [`0xf5266222…4d65`](https://basescan.org/tx/0xf526622256757407cccee3499161a4eebad77d5b3fdc3433cfe3079dda394d65)

Sent by Circle's CLI first, to learn how the wallets behave: the transactions that deployed each wallet ([Arc](https://explorer.testnet.arc.io/tx/0xc85d4380752a82f07832364b3fb5c2d721ee7a5e0decb14a97a297e657184ce8), [Base](https://basescan.org/tx/0x23a68448ace4b365ed192d5a13e4df6adefe633200f4fdff83a733a0125e9029)), a `circle services pay` on each network ([Arc](https://explorer.testnet.arc.io/tx/0x3e56973fa7779d1d989ff2c109134c2702d22875190a16b9c44c2c48ae093cb9?tab=token_transfers), [Base](https://basescan.org/tx/0xb7322949cdbef30a2ca20eb55a87944388f7c77290fe3ac1be5b97058e771823)), and a contract call that minted an ERC-1155 token to the Arc wallet ([`0x7fe9f47c…5e6a`](https://explorer.testnet.arc.io/tx/0x7fe9f47c4fc0b5f1fb3166131a6a2b64cd85acf6fcf1860ba51260b5c09f5e6a)).

## Development

```
npm install
npm test            # vitest, against a stand-in for Circle's proxy; no network
npm run typecheck
npm run build       # dist/
npm run smoke       # live, on Arc testnet: asks for your email and code, pays the seller in SMOKE_URL 0.01 USDC
```

The fake in `test/fake-circle.ts` is written with Node's own crypto from the CLI's source, so the library's AES, RSA and PIN code is checked against a second implementation rather than against itself. The library itself imports no Node built-ins.

## Licence

Apache-2.0. The protocol logic was ported from `@circle-fin/cli` (Apache-2.0, Circle Internet Group, Inc.); see [NOTICE](NOTICE).
