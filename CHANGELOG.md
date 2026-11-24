# Changelog

## 0.3.0 (not published yet)

Added, from the CLI's source and tested against the stand-in only:

- `signMessage()`, and message signing through the viem account.
- `balances()`, `wallets()` and `transactions()`.
- `cancel(id)` and `accelerate(id)`.
- `limits.owner.end()`, to drop the owner's token before its ten minutes are up.
- An optional `idempotencyKey` on `call()` and `transfer()`.

Fixed, after a review of the whole client:

- A transaction that was sent is no longer reported as failed. A failed status check is retried, and running out of time, or an approval lost on the way, is the new error `outcome_unknown`. Before, one dropped connection during the wait threw an error that read as a failure, and a retry could send the transaction twice.
- Overlapping logins no longer step on each other: a login replaced by a newer `start`, a `logout` or a `forget` stores nothing, and two `finish` calls share one answer.
- A login whose code was accepted and which then failed at a later step picks up from there. Before, a retry sent the spent code again and reported it as wrong.
- `deploy()` works when taken off the wallet object.
- `limits.reset(id)` says so when no rule has that id. `forget()` also drops a pending login and the owner's token.
- The example's payment helper says when a payment was already signed before the seller failed, and refuses a 402 that keeps a payment valid for more than an hour (`maxTimeoutSeconds` in the terms).

`limit_exceeded` and `not_allowed` now also apply to `signMessage()`.

## 0.2.0 (24 Nov 2026)

- First login creates the wallets on Base mainnet as well as Arc testnet. The error code `needs_cli_bootstrap` is gone.
- `deploy()`, `transfer()`, `fund()` and `searchServices()`.
- `limits`: read, budget, the owner login, `set()`, `setList()` and `reset()`, with the errors `limit_exceeded` and `not_allowed`.
- `logout()` also removes a session Circle refuses with 403.

## 0.1.0 (23 Nov 2026)

Login, wallet, balance, typed-data signing, a viem account, an x402 signer, contract calls, transaction status and logout.
