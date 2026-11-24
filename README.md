# agent-wallet-mobile

A small TypeScript client that logs in to a Circle Agent Wallet and signs with it from a React Native app, with no CLI on the device and no server in between. It also runs in Node.

**Unofficial.** This project is not affiliated with, sponsored by or endorsed by Circle. It talks to the same backend that Circle's own CLI (`@circle-fin/cli` 1.4.0) talks to, an API Circle has not documented for outside use and can change at any time. Read [Known gaps](#known-gaps) before relying on it for anything.

The code is lifted out of Nest, an iPhone app that pays for x402 resources and buys tokens from an agent wallet. This package is that client on its own. Its tests run against a stand-in for Circle's proxy, and it has run against Circle itself, from Node and from Nest on an iPhone, on Arc testnet and Base mainnet. [What has run for real](#what-has-run-for-real) says exactly which parts.

## Quick start

```
npm install agent-wallet-mobile viem
```

In React Native, add `react-native-keychain` and `react-native-get-random-values` as well.

```ts
import 'react-native-get-random-values';
import * as Keychain from 'react-native-keychain';
import { createAgentWallet, keychainStorage, searchServices } from 'agent-wallet-mobile';

const agent = createAgentWallet({ network: 'arc', storage: keychainStorage(Keychain) });

// Log in. Circle emails a code that reads "ABC-123456"; the six digits are enough.
await agent.login.prepare();          // optional: start making the login key early, it takes seconds on a phone
await agent.login.start(email);
const wallet = await agent.login.finish(code);   // { address, id, blockchain, network, expiresAt }
await agent.deploy();                 // once, after an account's first login: Circle will not sign for a wallet that is not on-chain yet

await agent.balance();                // "19.99", USDC as Circle reports it
await agent.balances();               // every token: [{ symbol, address, amount }]

// Sign: EIP-712 typed data or a plain message, as a viem account or as the signer @x402/evm asks for.
const account = await agent.account();
await account.signTypedData({ domain, types, primaryType, message });
await account.signMessage({ message: 'hello' });
registerExactEvmScheme(x402client, { signer: await agent.x402Signer() });

// Send a contract call or a token transfer. Circle's bundler submits it; the promise resolves once Circle reports it confirmed.
const { hash } = await agent.call({ to: contract, data: calldata });
await agent.transfer({ to: recipient, amount: '0.01' });    // USDC, or another token by its contract address
await agent.transactions();           // the wallet's latest transactions at Circle
await agent.fund();                   // Circle's testnet faucet

// Move USDC to this account's wallet on the other chain of the pair: Arc testnet to Base Sepolia, Base to Arc mainnet.
await agent.bridge.quote('5');        // { to, amount, fee, total }
const burn = await agent.bridge.send({ amount: '5' });
await agent.bridge.status(burn.hash); // { status, arrivalHash }: arrived once arrivalHash is set
await agent.bridge.balance();         // USDC the account holds on that other chain

// Paid services in Circle's Agent Marketplace. Public: it needs no login.
const services = await searchServices({ query: 'restaurants' });

// Circle's spending rules, mainnet only. Reading takes the agent's session; changing takes the owner's own emailed code.
await agent.limits.read();            // [{ ruleType, perTx, daily, weekly, monthly, addresses, origin: 'DEFAULT' | 'CUSTOM', id }]
await agent.limits.budget();          // what is left in each window
await agent.limits.owner.start(email);
await agent.limits.owner.finish(ownerCode);
await agent.limits.set({ perTx: '0.5', daily: '2', weekly: '10', monthly: '20' });
await agent.limits.setList('contract-allowlist', [seller]);    // the only contracts the wallet may call
await agent.limits.reset();           // back to Circle's default; reset(id) removes one rule
agent.limits.owner.end();             // drop the owner's token as soon as the rules are set

await agent.logout();                 // revoke this session at Circle; logout('all') revokes every device's
```

On the next launch, `createAgentWallet` with the same storage finds the session again: `agent.wallet()` answers without a network call, and throws `not_logged_in` or `session_expired` when there is nothing to use. `agent.session()` returns the stored session itself, and `isExpired(session)` says whether it is past its expiry.

[`examples/expo-app`](examples/expo-app) has a one-screen app (log in, balance, pay one x402 resource). It builds and installs on an iPhone; the app that has actually paid from one is Nest. Its payment helper, `x402.ts`, is the part the tests and the smoke script exercise.

## Errors

Every failure is an `AgentWalletError` with a `code`.

| `code` | Meaning |
|---|---|
| `not_logged_in`, `session_expired` | There is no session to use; log in. Also thrown by `limits.set()` and its siblings without an owner login. |
| `wrong_code` | Circle refused the emailed code. The login stays open, so `finish` can be called again. |
| `invalid_input` | The call was refused before anything was sent, or Circle would refuse it (a second rule of one kind). |
| `limit_exceeded` | Circle refused to sign or send because of the wallet's amount cap. Nothing moved. |
| `not_allowed` | Circle refused because of the owner's allow or block list. Nothing moved. |
| `transaction_failed` | Circle reports the transaction failed, was cancelled or was denied. |
| `outcome_unknown` | Circle took the request and has not said how it ended: a status check kept failing, or a minute ran out. The transaction may still happen. Look it up with `transaction(id)`, or retry with the same `idempotencyKey`; a fresh `call()` or `transfer()` could send it twice. |
| `http` | Circle answered with an error; `status` has the HTTP status. |
| `protocol` | Circle answered with something this client does not understand. |

`call()` and `transfer()` take an optional `idempotencyKey` (a UUID). Pass your own when a retry must never send twice.

## Security model

An agent wallet's key is split in two shares, both held by Circle (two-of-two MPC). Circle's terms say the shares "can only be invoked for signing with the user's secret credential". In practice that credential is a user secret Circle hands the client at login. For each signature Circle opens a challenge; the client approves it with a PIN hash derived from that secret and a share that comes with the challenge, encrypted to a key in the challenge. Nobody types a PIN. So the device approves every signature, but the device holds no key material of its own.

That makes the session a bearer credential. It is five values (`userToken`, `encryptionKey`, the sealed user secret, its `storageKey`, and a `deviceId` the client made up), and whoever holds them can sign for the wallet until the token expires. Nothing binds them to the device: no device key, no attestation. This is why the session belongs in the Keychain and nowhere else. `keychainStorage` stores it as `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so it is unreadable while the phone is locked and is never copied into a backup or onto another device. `memoryStorage`, the default, keeps it for the life of the process only. Do not write a session to a file, AsyncStorage or a log.

The library never stores, logs or returns the email or the code. The email lives in memory between `login.start` and `login.finish`; the code goes into one encrypted request. Errors carry Circle's HTTP status and numeric code, and Circle's own message only outside a login, where it could echo either.

Circle enforces spending rules on mainnet only (see [Limits and lists](#limits-and-lists)). On testnet it signs whatever typed data a valid session sends, so whatever limit you want there, or beyond Circle's, has to run in your app before `signTypedData` is called. `examples/expo-app/x402.ts` shows the shape: the 402's scheme, network, token, amount, payee and validity are checked against what the app expects, and a 402 that fails sends nothing to Circle. The tests cover each of those refusals.

Two smaller points. The wallet is a smart contract account, so its signatures verify through ERC-1271 rather than `ecrecover`, and only once the wallet is deployed; a new wallet needs one first transaction of any kind before a seller's facilitator will accept its signature. And requests go out with the runtime's own User-Agent. The library never claims to be Circle's CLI, and if Circle's proxy starts refusing other clients, that is a stop, not something to work around.

Circle's Agent Platform terms apply to whoever logs in: it is your account, on your device. Don't ship an app in which other people use your session.

## Limits and lists

Circle can restrict an agent wallet, and the agent cannot lift the restriction: changing a rule takes the wallet owner's own login, a second emailed code. This client keeps that owner token in memory for at most ten minutes and never stores it; call `limits.owner.end()` to drop it sooner. While it is held, whatever code holds the wallet object can change the rules, so end it before handing control back to an agent.

What Circle enforces, as seen from this client on Base mainnet on 24 Nov 2026:

| Rule | Set with | Covers | Seen refusing |
|---|---|---|---|
| Amount cap per payment, day, week and month | `limits.set()` | Stablecoin transfers and signed x402 payments | Yes: a 0.01 USDC payment and a 0.01 USDC transfer under a 0.005 cap, 400 with code 136001, "spend limit exceeded" |
| Contract allowlist | `limits.setList('contract-allowlist', …)` | Contract calls | Yes: a call to a contract off the list, 400 with code 136005, "Contract address is not on the allowlist."; a call to the listed contract went through ([`0xc1b9d1a8…083f`](https://basescan.org/tx/0xc1b9d1a8ca742038acef1e9ecb9460543919b16f9685ed75db5b5f658618083f)) |
| Contract blocklist, recipient allowlist and blocklist | `limits.setList(…)` | Contract calls; stablecoin transfers | Not run against Circle: the same request with another rule name |

In each refusal no challenge was opened and the balance did not move. With no custom rule Circle applies 100 USDC a month.

Three things to know before building on this:

- **Circle's amount caps do not cover contract calls.** The CLI offers that cap (`--policy-type contract` with a transfer limit), but Circle answered the request with a bare 400, so this client does not send it. For a contract call Circle restricts which contract, never how much: a cap on what a call may spend has to be the app's own check, made before `call()`.
- **The rules exist on mainnet only.** On testnet these calls throw `invalid_input` without asking Circle.
- **A rule is not replaced in place.** A second rule of the same kind is refused; call `limits.reset()` or `limits.reset(id)` first.

## Networks

| `network` | Chain | Circle environment | USDC |
|---|---|---|---|
| `arc` | Arc testnet (`ARC-TESTNET`, chain 5042002) | testnet proxy | `0x3600000000000000000000000000000000000000` |
| `base` | Base mainnet (`BASE`, chain 8453) | live proxy, real funds | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

Testnet and mainnet are separate Circle accounts with separate logins and wallets, so each needs its own `createAgentWallet` and its own emailed code. Other chains Circle supports would be a line each in `NETWORKS`; these two are the ones that were exercised.

## Known gaps

**The API is undocumented.** Every call was read out of the CLI's published source (see [docs/PROTOCOL.md](docs/PROTOCOL.md)), and a CLI release can change any of them without notice. `npm run drift` downloads the newest CLI and checks that every path, header and field this client depends on is still in it; a scheduled workflow runs it weekly. Half the endpoints do appear in Circle's user-controlled wallets reference, but there they are called with your own API key; here Circle's proxy adds its own.

**A session cannot be refreshed.** The CLI never keeps a refresh token and neither does this client, so when the session expires (the `exp` of the user token, about four weeks) the user logs in again with a new code.

**A new wallet cannot sign until it is deployed.** An account's first login creates its wallets, and this client does that itself on both networks. The new wallet is a smart contract account that is not on-chain yet, and Circle answers "Cannot generate a signature from an undeployed wallet" until it has sent one transaction. `deploy()` sends one that moves nothing, a zero USDC approve to the wallet itself, with the gas sponsored even for a wallet holding nothing.

**The bridge has moved test USDC only.** `bridge.send()` was written from the CLI's source and Circle's bridge kit: an approval, then a burn through Circle's bridge contract with its forwarder asked to mint on the other chain. On 24 Nov 2026 it took 0.10 USDC from Arc testnet to Base Sepolia (see [On-chain](#on-chain)). The mainnet route, Base to Arc, is the same code with other addresses and has not been run; a burn cannot be undone, so send a small amount first. It covers those two routes only. `bridge.balance()` reads the USDC the account holds on the second chain of the pair, as Circle reports it; it is tested against the stand-in only.

**Not built.** Gateway (Circle's prepaid balance for batched sellers), fee estimates, raw transactions, passkeys, the login path for accounts from before Circle's current flow, and the CLI's swap, earn and borrow commands. Earn is not possible yet: the CLI itself refuses it for agent wallets ("not yet supported for agent wallets").

**Only an iPhone has run this code.** Android goes through the same `react-native-keychain` call and should work, but nobody has tried. The approval request still carries the device description the CLI sends (`WebSDK`, `Desktop`), because that is the only value known to pass.

**The login key is slow to make.** An RSA-2048 key in pure JavaScript took about 22 seconds in Node with the JIT off, used as a stand-in for a phone's engine; it was not timed on the iPhone. Call `login.prepare()` when the email field gets focus so the wait hides behind typing. The key is made in 50 ms slices with a `setTimeout` between them. That is deliberate: node-forge's own async generation chains `setImmediate`, which React Native 0.88 runs as a microtask, and the app froze until the key was done.

## What has run for real

"Circle" below means run against Circle from this package, with each transaction checked on-chain; the hashes are under [On-chain](#on-chain). Everything is also covered by tests against the stand-in.

| Capability | Arc testnet | Base mainnet | From an iPhone |
|---|---|---|---|
| Login with the emailed code | Circle | Circle | Yes |
| First login that creates the wallets, `deploy()` | Circle | Circle | No |
| `balance()` | Circle | Circle | Yes |
| x402 payment through `x402Signer()` | Circle | Circle | Yes |
| `call()`, `transaction()` | Circle | Circle | Yes, on Arc |
| `transfer()` | Circle | Circle | No |
| `fund()` | Circle | Testnet only | No |
| `searchServices()` | Circle (one public list, not tied to a chain) | | No |
| `limits.read()`, `budget()`, owner login, `set()`, `reset()` | Mainnet only | Circle | No |
| Contract allowlist and its refusal | Mainnet only | Circle | No |
| `logout('local')` | Circle | Circle | No |
| `signMessage()`, `balances()`, `wallets()`, `transactions()` | Circle | Stand-in only | No |
| `cancel()`, `accelerate()` | Stand-in only | Stand-in only | No |
| `bridge.quote()`, `bridge.send()`, `bridge.status()` | Circle, to Base Sepolia | Stand-in only | No |
| Blocklists, recipient lists, `reset(id)` | Mainnet only | Stand-in only | No |
| `logout('all')` | Never sent | Never sent | No |

The rows marked "stand-in only" were written from the CLI's source and have never met Circle. The message signature was checked on-chain on 24 Nov 2026: the wallet itself, asked through ERC-1271 `isValidSignature`, accepted the 65-byte signature Circle returned. That run also listed the account's wallets, one address on nine testnet chains.

## On-chain

Everything is from 23 and 24 Nov 2026. Unless a line says otherwise it is one account: agent wallet `0x7286ec1ec69b477bba05ce28a21b1e03748b7765` on Arc testnet and `0xece745ef9d38a03473a5adafa6b71951170448d4` on Base mainnet. Each transaction was checked against the chain's RPC.

Sent by this package, run from Node against Circle's testnet proxy:

- An x402 payment of 0.01 USDC, signed through Circle and settled with the smart-account form of `transferWithAuthorization` (`0xcf092995`): [`0x4bb1e202…c51d`](https://explorer.testnet.arc.io/tx/0x4bb1e202471053a2303743172cec4395133d77998c0669c8b3f8767fb860c51d?tab=token_transfers)
- A contract call, a zero USDC `approve`, sent through EntryPoint v0.7 with the gas sponsored: [`0xe9cb7dd5…0ecb`](https://explorer.testnet.arc.io/tx/0xe9cb7dd52ad721be8c1c0aef6b1e61772921397d2098276e37157f814b4c0ecb)
- A logout, after which Circle's proxy answered the old session with 403.
- On 24 Nov 2026, a token transfer of 0.01 USDC through EntryPoint v0.7: [`0xe258283f…3546`](https://explorer.testnet.arc.io/tx/0xe258283f657f508ea4077026858939d14a7014c3be8dae417263b5ad7bf43546?tab=token_transfers), beside a second x402 payment, [`0x1e6a3b87…f0b7`](https://explorer.testnet.arc.io/tx/0x1e6a3b877865d456ab8b75b32dd44b09d62c8e8b8e56a37cbdc6ddab0704f0b7?tab=token_transfers)
- In the same run, a faucet request: the wallet's balance rose by 20 USDC (18.85 before, 38.83 after the two 0.01 payments). I did not find the faucet's own transaction.

Sent by this package on Base mainnet, on 24 Nov 2026, with real USDC and the gas sponsored (the balance fell by exactly the 0.01 payment):

- An x402 payment of 0.01 USDC to Agentic Reservations, settled with the v, r, s form of `transferWithAuthorization` (`0xe3ee160e`): [`0x1f6c9133…edac`](https://basescan.org/tx/0x1f6c913395dfff87e187c6185cdba3132be772d396268acc6d0563f32a1eedac)
- A contract call, a zero USDC `approve`: [`0x7d7227bf…11cc`](https://basescan.org/tx/0x7d7227bf69241184c0be9dddf954ed886c3c0db6f16858feeaea2fa72f4b11cc)
- A transfer of 0.01 USDC from the wallet to itself: [`0xc3cafc69…e38a`](https://basescan.org/tx/0xc3cafc694fe5347b17f06bfaeea98eb280acf7d58221e63b3a43af004951e38a)
- A spending limit of 0.005 USDC per payment set with a second emailed code, two refusals under it, and a reset to Circle's default of 100 USDC a month. None of those is a transaction.

First logins through this package, with never-used email addresses and no CLI, on 24 Nov 2026:

- Arc testnet: a new wallet, `0x5a5d4af9730fd92f4db96a1c3f5b980a9879e0f6`. The faucet's 20 USDC arrived, `deploy()` put it on-chain with the gas sponsored ([`0xd8f7a76f…fd12`](https://explorer.testnet.arc.io/tx/0xd8f7a76f6f9d24ecab4fc0868149937d15751bbd8cfae677abd208aede81fd12)), and its first x402 payment then settled ([`0xc7688296…a96f`](https://explorer.testnet.arc.io/tx/0xc768829662215b78ad480bac0b0a192c0e47fd626a82f4307e35ebe39bdfa96f?tab=token_transfers)). Before `deploy()`, Circle had refused to sign for it.
- Base mainnet: a new wallet, `0xa7b8def3f516eceef79632f2ee6991e9d6137fd5`, deployed while it held no ETH and no USDC, so Circle sponsored that gas too ([`0xe688e30a…a028`](https://basescan.org/tx/0xe688e30a08d30f992666ca10511de3a870cbea1c2f0fd514c3b7b10f4a1fa028)).

A bridge through this package on 24 Nov 2026, from Arc testnet to the same address on Base Sepolia:

- The burn: 0.152664 USDC left the wallet, 0.10 to arrive and 0.052664 for Circle's forwarder, through Circle's bridge contract: [`0xfdac0df1…76fe`](https://explorer.testnet.arc.io/tx/0xfdac0df1e91da6070c69a9c404af6a718ea5fd4163e02ca724b7f58abbf876fe?tab=token_transfers)
- The mint, sent by Circle's forwarder with no gas from the wallet: 0.10 USDC to the wallet on Base Sepolia: [`0x0f77dd04…447b`](https://sepolia.basescan.org/tx/0x0f77dd04387ce19cad428996fb7d90077f33fcc429cdcdd1ee60829f6565447b)

Sent by this package from an iPhone, inside Nest, on 23 Nov 2026 (UTC):

- An x402 payment of 0.01 USDC on Base mainnet to Agentic Reservations: [`0x1b3dc0b9…5f88`](https://basescan.org/tx/0x1b3dc0b90377eff263f1b361d8e69e90299a7129fa24bac5d861da097fb05f88)
- An x402 payment of 0.01 USDC on Arc testnet: [`0xda48ce10…d46e`](https://explorer.testnet.arc.io/tx/0xda48ce10c39f76a56c73d76ffc3af07da751b1eebe4b5668b9e35349e4bbd46e?tab=token_transfers)
- A contract call on Arc testnet, a 1.00 USDC buy through EntryPoint v0.7: [`0xa6cc0442…0f76`](https://explorer.testnet.arc.io/tx/0xa6cc0442a084ad03be75abeae9fe25e0a70cf95d9974715f10e7c3460bb50f76?tab=token_transfers)

Sent by an iPhone earlier, from the same client while it still lived inside Nest:

- Two 0.01 USDC payments on Arc testnet: [`0xe65982f0…c803`](https://explorer.testnet.arc.io/tx/0xe65982f0a2548aac3df2fd9fccd46dcb681e330c0a4e8465261b7bf386d7c803?tab=token_transfers) and [`0x93e54e3e…b09e`](https://explorer.testnet.arc.io/tx/0x93e54e3e3b55f212e99954ba6c74183dfb170d2f908b4b708b58cc2e6264b09e?tab=token_transfers)
- 0.01 USDC on Base mainnet to Agentic Reservations, a seller from Circle's Agent Marketplace: [`0xf5266222…4d65`](https://basescan.org/tx/0xf526622256757407cccee3499161a4eebad77d5b3fdc3433cfe3079dda394d65)

Sent by Circle's CLI first, to learn how the wallets behave: the transactions that deployed each wallet ([Arc](https://explorer.testnet.arc.io/tx/0xc85d4380752a82f07832364b3fb5c2d721ee7a5e0decb14a97a297e657184ce8), [Base](https://basescan.org/tx/0x23a68448ace4b365ed192d5a13e4df6adefe633200f4fdff83a733a0125e9029)), a `circle services pay` on each network ([Arc](https://explorer.testnet.arc.io/tx/0x3e56973fa7779d1d989ff2c109134c2702d22875190a16b9c44c2c48ae093cb9?tab=token_transfers), [Base](https://basescan.org/tx/0xb7322949cdbef30a2ca20eb55a87944388f7c77290fe3ac1be5b97058e771823)), and a contract call that minted an ERC-1155 token to the Arc wallet ([`0x7fe9f47c…5e6a`](https://explorer.testnet.arc.io/tx/0x7fe9f47c4fc0b5f1fb3166131a6a2b64cd85acf6fcf1860ba51260b5c09f5e6a)).

## Development

```
npm install
npm test            # vitest, against a stand-in for Circle's proxy; no network
npm run typecheck
npm run build       # dist/
npm run drift       # compare this client's calls with the newest Circle CLI on npm
npm run smoke       # live, on Arc testnet: asks for your email and code, pays the seller in SMOKE_URL 0.01 USDC
```

The fake in `test/fake-circle.ts` is written with Node's own crypto from the CLI's source, so the library's AES, RSA and PIN code is checked against a second implementation rather than against itself. The library itself imports no Node built-ins. `scripts/smoke.mjs` lists the flags for the other live runs, Base mainnet among them; every one logs out at the end and checks that Circle then refuses the old session.

## Licence

Apache-2.0. The protocol logic was ported from `@circle-fin/cli` (Apache-2.0, Circle Internet Group, Inc.); see [NOTICE](NOTICE).
