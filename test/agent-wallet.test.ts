import forge from 'node-forge';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { checkRequirement, payOnce, type Terms } from '../examples/expo-app/x402.js';
import { AgentWalletError, createAgentWallet, isExpired, keychainStorage, memoryStorage, searchServices, type Network, type Session, type Storage } from '../src/index.js';
import { ARC_USDC, BASE_USDC, CODE, EMAIL, HEAD, MINED, OWNER_TOKEN, SECRET, SHARE, SIGNATURE, WALLETS, fakeCircle, sha256, unwrapPinhash, user } from './fake-circle.js';

const KEY = { arc: 'circle-agent-wallet.arc', base: 'circle-agent-wallet.base' } as const;
const code = (error: unknown) => (error instanceof AgentWalletError ? error.code : `not an AgentWalletError: ${String(error)}`);
const fresh = (network: Network = 'arc', options?: Parameters<typeof fakeCircle>[1]) => {
  const circle = fakeCircle(network, options); const storage = memoryStorage();
  return { circle, storage, wallet: createAgentWallet({ network, fetch: circle.fetch, storage }) };
};
// One real login per network for the tests that only need a session: an RSA-2048 key takes a moment to make.
const saved = {} as Record<Network, string>;
beforeAll(async () => {
  for (const network of ['arc', 'base'] as const) {
    const { wallet, storage } = fresh(network);
    await wallet.login.start(EMAIL); await wallet.login.finish(CODE);
    saved[network] = (await storage.get(KEY[network]))!;
  }
}, 120_000);
const loggedIn = async (network: Network = 'arc', options?: Parameters<typeof fakeCircle>[1], session = saved[network]) => {
  const made = fresh(network, options);
  await made.storage.set(KEY[network], session);
  return made;
};

describe('login key', () => {
  // On React Native 0.88 setImmediate is a microtask, so forge's own async key generation, a chain of them, froze the app.
  it('lets timers run while the key is made, even where setImmediate is a microtask', async () => {
    const util = forge.util as unknown as { setImmediate(callback: () => void): void }; // in forge, missing from its types
    const original = util.setImmediate;
    util.setImmediate = callback => queueMicrotask(callback);
    const rsa = forge.pki.rsa as unknown as { stepKeyPairGenerationState(state: object, ms: number): boolean };
    const step = rsa.stepKeyPairGenerationState;
    let slices = 0;
    rsa.stepKeyPairGenerationState = (state, ms) => { slices++; return step(state, ms); };
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    try { await fresh().wallet.login.prepare(); } finally { clearInterval(timer); util.setImmediate = original; rsa.stepKeyPairGenerationState = step; }
    expect(ticks).toBeGreaterThan(0);
    expect(ticks).toBeGreaterThanOrEqual(slices - 1); // a timer got its turn after every 50 ms slice, not only once at the start
  }, 120_000);
  it('makes a new key for each login attempt, and uses the prepared one', async () => {
    const { wallet, circle } = fresh();
    await wallet.login.prepare();
    await wallet.login.start(EMAIL); const first = circle.seen.clientKey;
    delete circle.seen.deviceId; // a new attempt is a new device to Circle
    await wallet.login.start(EMAIL);
    expect(first).toMatch(/^-----BEGIN PUBLIC KEY-----\n/);
    expect(circle.seen.clientKey).not.toBe(first);
  }, 120_000);
});

describe('login', () => {
  it('logs in with the six digits from the email, adds the code prefix Circle expects, and stores a session with no email in it', async () => {
    const { wallet, circle, storage } = fresh();
    expect(await wallet.session()).toBeNull();
    expect(await wallet.login.start(EMAIL)).toEqual({ codePrefix: HEAD });
    const info = await wallet.login.finish(CODE);
    expect(info).toEqual({ id: 'w-arc', address: WALLETS.arc.address, blockchain: 'ARC-TESTNET', network: 'arc', expiresAt: expect.any(Number) });
    expect(info.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
    expect(info.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect(await wallet.wallet()).toEqual(info);
    const stored = (await storage.get(KEY.arc))!;
    expect(JSON.parse(stored)).toMatchObject({ network: 'arc', walletId: 'w-arc', address: WALLETS.arc.address, userToken: user.token, encryptionKey: user.key, deviceId: circle.seen.deviceId });
    expect(stored).not.toContain(EMAIL);
    expect(stored).not.toContain(CODE);
    expect(stored).not.toContain(SECRET); // only ever stored sealed
    expect(JSON.stringify(info)).not.toContain(user.token);
    expect(circle.calls).toEqual(['POST /v1/w3s/auth/deviceToken', 'POST /v1/w3s/auth/challenges', 'GET /config', 'GET /v1/w3s/sdk/auth/challenges/auth-1',
      'POST /v1/w3s/sdk/auth/challenges/auth-1/factors', 'GET /v1/w3s/auth/challenges/auth-1', 'GET /v1/w3s/wallets']);
  });
  it('takes the code typed with its prefix, in either case, or padded, and can retry after a wrong one', async () => {
    const { wallet, circle } = fresh();
    await wallet.login.start(EMAIL);
    expect(code(await wallet.login.finish('000000').catch(e => e))).toBe('wrong_code');
    await expect(wallet.login.finish(`ZZZ-${CODE}`)).rejects.toThrow('That code is not the one from the latest email');
    expect(circle.calls.filter(call => call.endsWith('/factors'))).toHaveLength(1); // the other prefix was refused before sending
    await expect(wallet.login.finish('12345')).rejects.toThrow('The code is six digits');
    await expect(wallet.login.finish(`${HEAD.toLowerCase()}-${CODE} `)).resolves.toMatchObject({ id: 'w-arc' });
    await expect(wallet.login.finish(CODE)).rejects.toThrow('No login in progress'); // the login is used up
  });
  it('creates the wallets on a first testnet login, on every testnet chain the CLI asks for, and only then looks the wallet up', async () => {
    const { wallet, circle, storage } = fresh('arc', { operation: 'bootstrap' });
    await wallet.login.start(EMAIL);
    expect(await wallet.login.finish(CODE)).toMatchObject({ address: WALLETS.arc.address });
    expect(circle.seen.initialize).toMatchObject({ accountType: 'SCA', blockchains: expect.arrayContaining(['ARC-TESTNET', 'BASE-SEPOLIA']) });
    expect(circle.seen.initialize.blockchains).toHaveLength(9);
    expect(circle.seen.approve.pinType).toBe('AUTO');
    const order = circle.calls.map(call => call.replace(/\?.*/, ''));
    expect(order.indexOf('GET /v1/w3s/user/challenges/init-1')).toBeLessThan(order.indexOf('GET /v1/w3s/wallets'));
    expect(await storage.get(KEY.arc)).not.toBeNull();
  }, 120_000);
  it('takes an account Circle says is already set up (409) without a challenge', async () => {
    const { wallet, circle } = fresh('arc', { operation: 'bootstrap', initialize: 409 });
    await wallet.login.start(EMAIL);
    expect(await wallet.login.finish(CODE)).toMatchObject({ address: WALLETS.arc.address });
    expect(circle.calls.some(call => call.includes('init-1'))).toBe(false);
  }, 120_000);
  it('stores no session when Circle fails to create the wallets', async () => {
    const { wallet, storage } = fresh('arc', { operation: 'bootstrap', initialize: 'FAILED' });
    await wallet.login.start(EMAIL);
    expect(code(await wallet.login.finish(CODE).catch(e => e))).toBe('protocol');
    expect(await storage.get(KEY.arc)).toBeNull();
  }, 120_000);
  it('creates the wallets on a first mainnet login too, on the mainnet chains and none of the testnet ones', async () => {
    const { wallet, circle } = fresh('base', { operation: 'bootstrap' });
    await wallet.login.start(EMAIL);
    expect(await wallet.login.finish(CODE)).toMatchObject({ address: WALLETS.base.address, blockchain: 'BASE' });
    expect(circle.seen.initialize.blockchains).toEqual(['ETH', 'MATIC', 'ARB', 'AVAX', 'OP', 'BASE', 'UNI', 'MONAD', 'ARC']);
  }, 120_000);
  // A wrapper round the stand-in that can hold back, or fail once, the calls whose path matches.
  const meddling = (network: Network, match: string, how: 'hold' | 'fail once') => {
    const circle = fakeCircle(network); const storage = memoryStorage();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let failed = false;
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes(match)) {
        if (how === 'hold') await held;
        else if (!failed) { failed = true; return new Response('{}', { status: 503 }); }
      }
      return circle.fetch(input, init);
    }) as typeof globalThis.fetch;
    return { circle, storage, release, wallet: createAgentWallet({ network, fetch, storage }) };
  };
  it('stores nothing when the wallet is forgotten while a login is still finishing', async () => {
    const { wallet, storage, release } = meddling('arc', '/v1/w3s/wallets', 'hold');
    await wallet.login.start(EMAIL);
    const finishing = wallet.login.finish(CODE).catch(e => e);
    await wallet.forget();
    release();
    expect(code(await finishing)).toBe('invalid_input');
    expect(await storage.get(KEY.arc)).toBeNull();
  }, 120_000);
  it('lets a newer login finish while an older one is still finishing, and throws the older one away', async () => {
    const { wallet, circle, storage, release } = meddling('arc', '/v1/w3s/wallets', 'hold');
    await wallet.login.start(EMAIL);
    const older = wallet.login.finish(CODE).catch(e => e);
    delete circle.seen.deviceId; // a new login is a new device to Circle
    await wallet.login.start(EMAIL);
    const newer = wallet.login.finish(CODE);
    release();
    expect(code(await older)).toBe('invalid_input');
    expect(await newer).toMatchObject({ address: WALLETS.arc.address });
    expect(await storage.get(KEY.arc)).not.toBeNull();
  }, 120_000);
  it('answers two finishes of one login with the same wallet, sending the code once', async () => {
    const { wallet, circle } = fresh();
    await wallet.login.start(EMAIL);
    const [first, second] = await Promise.all([wallet.login.finish(CODE), wallet.login.finish(CODE)]);
    expect(second).toEqual(first);
    expect(circle.calls.filter(call => call.endsWith('/factors'))).toHaveLength(1);
  }, 120_000);
  it('picks a login up where it stopped when a step after the accepted code fails, without sending the spent code again', async () => {
    const { wallet, circle, storage } = meddling('arc', '/v1/w3s/wallets', 'fail once');
    await wallet.login.start(EMAIL);
    expect(code(await wallet.login.finish(CODE).catch(e => e))).toBe('http');
    expect(await storage.get(KEY.arc)).toBeNull();
    expect(await wallet.login.finish(CODE)).toMatchObject({ address: WALLETS.arc.address });
    expect(circle.calls.filter(call => call.endsWith('/factors'))).toHaveLength(1);
  }, 120_000);
  it('never puts the email or the code in an error', async () => {
    const circle = fakeCircle();
    const failing: typeof fetch = async (input, init) => (String(input).endsWith('/auth/challenges')
      ? new Response(JSON.stringify({ message: `bad destination ${EMAIL}` }), { status: 422 }) : circle.fetch(input, init));
    const failure = await createAgentWallet({ network: 'arc', fetch: failing }).login.start(EMAIL).catch(e => e);
    expect(code(failure)).toBe('http');
    expect(failure.status).toBe(422);
    expect(failure.message).not.toContain(EMAIL);
    // And when the code is refused with an answer that repeats both.
    const echoing: typeof fetch = async (input, init) => (String(input).endsWith('/factors')
      ? new Response(JSON.stringify({ message: `code ${HEAD}-654321 for ${EMAIL} is wrong` }), { status: 500 }) : circle.fetch(input, init));
    const wallet = createAgentWallet({ network: 'arc', fetch: echoing });
    await wallet.login.start(EMAIL);
    const refused = await wallet.login.finish('654321').catch(e => e);
    expect(code(refused)).toBe('http');
    expect(refused.message).not.toContain(EMAIL);
    expect(refused.message).not.toContain('654321');
  }, 120_000);
});

describe('networks', () => {
  it("logs in through Circle's live proxy for Base, finds the BASE wallet, reads Base USDC, and signs there", async () => {
    const { wallet, circle } = await loggedIn('base');
    expect(await wallet.wallet()).toMatchObject({ network: 'base', id: 'w-base', address: WALLETS.base.address, blockchain: 'BASE' });
    expect(await wallet.balance()).toBe('0.99');
    const signature = await wallet.signTypedData({ domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: BASE_USDC },
      types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }] }, primaryType: 'TransferWithAuthorization', message: { from: WALLETS.base.address } });
    expect(signature).toBe(SIGNATURE);
    expect(circle.seen.typedData.domain.chainId).toBe(8453);
  });
  it("lists the account's wallets on every chain, and this wallet's latest transactions", async () => {
    const { wallet } = await loggedIn();
    expect(await wallet.wallets()).toEqual([{ id: 'w-arc', address: WALLETS.arc.address, blockchain: 'ARC-TESTNET' },
      { id: 'w-other', address: '0x1111111111111111111111111111111111111111', blockchain: 'BASE-SEPOLIA' }]);
    expect(await wallet.transactions(2)).toEqual([{ id: 't-9', state: 'CONFIRMED', hash: MINED, errorReason: null, operation: 'CONTRACT_EXECUTION' },
      { id: 't-8', state: 'FAILED', hash: null, errorReason: 'INSUFFICIENT_TOKEN_BALANCE', operation: 'TRANSFER' }]);
    expect(code(await wallet.transactions(0).catch(e => e))).toBe('invalid_input');
  });
  it('lists every token the wallet holds, not only USDC', async () => {
    const { wallet } = await loggedIn();
    expect(await wallet.balances()).toEqual([{ symbol: 'EURC', address: '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1', amount: '1.5' },
      { symbol: 'USDC', address: BASE_USDC.toLowerCase(), amount: '0.99' }, { symbol: 'USDC', address: ARC_USDC, amount: '19.99' }]);
  });
  it("reads the wallet's USDC on Arc testnet, picked by token address", async () => {
    expect(await (await loggedIn()).wallet.balance()).toBe('19.99');
  });
  it('refuses a session stored for the other network', async () => {
    const { wallet, circle } = await loggedIn('arc', undefined, saved.base);
    expect(code(await wallet.balance().catch(e => e))).toBe('not_logged_in');
    expect(circle.calls).toEqual([]);
  });
});

describe('session', () => {
  it('asks for a login when there is none, and for a new one once it has expired, without calling Circle', async () => {
    const { wallet, circle } = fresh();
    expect(code(await wallet.balance().catch(e => e))).toBe('not_logged_in');
    const old: Session = { ...JSON.parse(saved.arc), expiresAt: Date.now() - 1 };
    const expired = await loggedIn('arc', undefined, JSON.stringify(old));
    expect(isExpired(old)).toBe(true);
    expect(isExpired(JSON.parse(saved.arc))).toBe(false);
    expect((await expired.wallet.session())?.expiresAt).toBe(old.expiresAt); // still readable, so the app can say when it ended
    for (const use of [() => expired.wallet.balance(), () => expired.wallet.account(), () => expired.wallet.call({ to: WALLETS.arc.address, data: '0x' })])
      expect(code(await use().catch(e => e))).toBe('session_expired');
    expect([...circle.calls, ...expired.circle.calls]).toEqual([]);
  });
});

describe('signing', () => {
  const typed = { domain: { name: 'USDC', version: '2', chainId: 5042002, verifyingContract: ARC_USDC },
    types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'value', type: 'uint256' }] },
    primaryType: 'TransferWithAuthorization', message: { from: WALLETS.arc.address, value: 10000n } } as const;

  it('has Circle sign typed data, approved with the PIN derived from the user secret and the challenge share', async () => {
    const { wallet, circle } = await loggedIn();
    const account = await wallet.account();
    expect(account).toMatchObject({ address: WALLETS.arc.address, type: 'local' });
    expect(await account.signTypedData(typed)).toBe(SIGNATURE);
    expect(circle.calls).toEqual(['POST /v1/w3s/user/sign/typedData', 'GET /v1/w3s/sdk/user/challenges/sig-1', 'POST /v1/w3s/sdk/user/challenges/sig-1/approve']);
    expect(circle.seen.typedData.types.EIP712Domain.map((f: { name: string }) => f.name)).toEqual(['name', 'version', 'chainId', 'verifyingContract']);
    expect(circle.seen.typedData).toMatchObject({ primaryType: 'TransferWithAuthorization', domain: typed.domain, message: { value: '10000' } }); // integers as decimal strings

    // What Circle's server would unwrap, worked out here with Node's crypto.
    const pin = sha256(`${SECRET.split(':')[0]}${SHARE}`, 'latin1').toString('base64');
    const pinhash = sha256(pin);
    const hex = (data: Buffer) => data.toString('hex').toUpperCase();
    const approve = circle.seen.approve;
    expect(approve.pinType).toBe('AUTO');
    expect(approve.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(unwrapPinhash(approve.pinhash)).toBe(pinhash.toString('base64'));
    expect(approve.hashPinhash).toBe(sha256(pinhash).toString('base64'));
    expect(approve.additionalPinhash.version).toBe(0);
    expect(unwrapPinhash(approve.additionalPinhash.pinhash)).toBe(Buffer.from(hex(pinhash)).toString('base64'));
    expect(approve.additionalPinhash.hashPinhash).toBe(Buffer.from(hex(sha256(hex(pinhash)))).toString('base64'));
    expect(approve.deviceInfo).toEqual({ os: { model: '', version: '' }, browser: { model: 'WebSDK', version: '' }, device: { model: 'Desktop', version: '' }, sdk: { model: 'Web', version: '' } });
  });
  // Reported from Base mainnet on 24 Nov 2026: with a per-payment limit of 0.005 USDC, Circle refused to sign a 0.01 USDC payment.
  it("names Circle's spending limit when it refuses to sign, keeps Circle's reason, and opens no challenge", async () => {
    const { wallet, circle } = await loggedIn('arc', { overLimit: true });
    const error = await wallet.signTypedData(typed).catch(e => e);
    expect(code(error)).toBe('limit_exceeded');
    expect(error.message).toContain('spend limit exceeded');
    expect(circle.calls).toEqual(['POST /v1/w3s/user/sign/typedData']);
  });
  it('has Circle sign a plain message, as text or as raw bytes, through the viem account too', async () => {
    const { wallet, circle } = await loggedIn();
    expect(await wallet.signMessage('hello')).toBe(SIGNATURE);
    expect(circle.seen.message).toEqual({ walletId: 'w-arc', message: 'hello' });
    expect(circle.calls).toEqual(['POST /v1/w3s/user/sign/message', 'GET /v1/w3s/sdk/user/challenges/sig-1', 'POST /v1/w3s/sdk/user/challenges/sig-1/approve']);
    const account = await wallet.account();
    expect(await account.signMessage({ message: { raw: '0xdeadbeef' } })).toBe(SIGNATURE);
    expect(circle.seen.message).toEqual({ walletId: 'w-arc', message: '0xdeadbeef', encodedByHex: true });
    expect(await account.signMessage({ message: { raw: new Uint8Array([1, 2, 255]) } })).toBe(SIGNATURE);
    expect(circle.seen.message.message).toBe('0x0102ff');
  });
  it('refuses raw bytes that are not hex, and says so rather than signing a raw transaction, which this client does not do', async () => {
    const { wallet, circle } = await loggedIn();
    expect(code(await wallet.signMessage({ raw: '0xnothex' as `0x${string}` }).catch(e => e))).toBe('invalid_input');
    await expect((await wallet.account()).signTransaction({ to: WALLETS.arc.address })).rejects.toThrow('send transactions with call()');
    expect(circle.calls).toEqual([]);
  });
});

describe('call', () => {
  const SELLER = '0xf46f48677e11aae0f3354aa69b2fa10c8fd8dbe8';
  it('runs a contract call as a Circle transaction, approved with the derived PIN, and returns the hash once Circle says it is confirmed', async () => {
    const { wallet, circle } = await loggedIn();
    await expect(wallet.call({ to: SELLER, data: '0xabcdef' })).resolves.toEqual({ hash: MINED, transactionId: 't-9' });
    expect(circle.seen.execution).toMatchObject({ walletId: 'w-arc', sourceAddress: WALLETS.arc.address, blockchain: 'ARC-TESTNET', contractAddress: SELLER, callData: '0xabcdef', feeLevel: 'MEDIUM' });
    expect(circle.seen.execution.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(circle.seen.approve.pinType).toBe('AUTO');
    expect(circle.seen.polls).toBe(2);
    expect(await wallet.transaction('t-9')).toEqual({ id: 't-9', state: 'CONFIRMED', hash: MINED, errorReason: null });
  });
  it('deploys a new wallet with a call that moves nothing: a zero USDC approve to itself', async () => {
    const { wallet, circle } = await loggedIn();
    await expect(wallet.deploy()).resolves.toEqual({ hash: MINED, transactionId: 't-9' });
    expect(circle.seen.execution).toMatchObject({ contractAddress: ARC_USDC, callData: `0x095ea7b3${'0'.repeat(24)}${WALLETS.arc.address.slice(2)}${'0'.repeat(64)}` });
  });
  it('keeps waiting through a failed status check and an approval whose transaction is not listed yet, so a sent call is never reported as failed', async () => {
    const { wallet, circle } = await loggedIn('arc', { flaky: true });
    await expect(wallet.call({ to: SELLER, data: '0xabcdef' })).resolves.toEqual({ hash: MINED, transactionId: 't-9' });
    expect(circle.seen.polls).toBe(3);
  });
  it('says the outcome is unknown, with the challenge to look up, when Circle may have taken the approval', async () => {
    const { wallet } = await loggedIn('arc', { approveLost: true });
    const error = await wallet.call({ to: SELLER, data: '0xabcdef' }).catch(e => e);
    expect(code(error)).toBe('outcome_unknown');
    expect(error.message).toContain('tx-1');
  });
  it('keeps waiting when Circle refuses one status check after the approval, since the transaction is already on its way', async () => {
    const { wallet } = await loggedIn('arc', { busy: true });
    await expect(wallet.call({ to: SELLER, data: '0xabcdef' })).resolves.toEqual({ hash: MINED, transactionId: 't-9' });
  });
  it('carries on when Circle says the challenge was approved already, as on a retry of one it took', async () => {
    const { wallet } = await loggedIn('arc', { alreadyApproved: true });
    await expect(wallet.call({ to: SELLER, data: '0xabcdef' })).resolves.toEqual({ hash: MINED, transactionId: 't-9' });
  });
  it("sends the caller's idempotency key to Circle, for calls and for transfers, and refuses one that is not a UUID", async () => {
    const { wallet, circle } = await loggedIn();
    const idempotencyKey = '0b0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3';
    await wallet.call({ to: SELLER, data: '0xabcdef', idempotencyKey });
    expect(circle.seen.execution.idempotencyKey).toBe(idempotencyKey);
    await wallet.transfer({ to: SELLER, amount: '0.01', idempotencyKey });
    expect(circle.seen.transfer.idempotencyKey).toBe(idempotencyKey);
    expect(code(await wallet.call({ to: SELLER, data: '0xabcdef', idempotencyKey: 'again' }).catch(e => e))).toBe('invalid_input');
  });
  it('still works when the method is taken off the wallet object', async () => {
    const { wallet } = await loggedIn();
    const { deploy } = wallet;
    await expect(deploy()).resolves.toEqual({ hash: MINED, transactionId: 't-9' });
  });
  // Seen on Base mainnet on 24 Nov 2026, with an allowlist of one other contract.
  it("names Circle's refusal when the contract is not on the owner's allowlist, and opens no challenge", async () => {
    const { wallet, circle } = await loggedIn('arc', { offList: true });
    const error = await wallet.call({ to: SELLER, data: '0xabcdef' }).catch(e => e);
    expect(code(error)).toBe('not_allowed');
    expect(error.message).toContain('not on the allowlist');
    expect(circle.calls).toEqual(['POST /v1/w3s/user/transactions/contractExecution']);
  });
  it("throws Circle's reason when the transaction fails, with its id, so nothing reads as done", async () => {
    const { wallet } = await loggedIn('arc', { transaction: { state: 'FAILED', errorReason: 'EXECUTION_REVERTED', txHash: MINED } });
    const failure = await wallet.call({ to: SELLER, data: '0xabcdef' }).catch(e => e);
    expect(code(failure)).toBe('transaction_failed');
    expect(failure.message).toBe('Circle transaction t-9 FAILED: EXECUTION_REVERTED');
  });
});

describe('cancel and accelerate', () => {
  it.each(['cancel', 'accelerate'] as const)('asks Circle to %s a transaction, approves that like any other, and reports where the transaction then stands', async change => {
    const { wallet, circle } = await loggedIn('arc', { transaction: { state: change === 'cancel' ? 'CANCELLED' : 'SENT', txHash: MINED } });
    expect(await wallet[change]('t-9')).toEqual({ id: 't-9', state: change === 'cancel' ? 'CANCELLED' : 'SENT', hash: MINED, errorReason: null });
    expect(circle.seen.change).toBe(change);
    expect(circle.seen.approve.pinType).toBe('AUTO');
  });
});

describe('cancel and accelerate, when the approval may have been lost', () => {
  it('says the outcome is unknown rather than failed', async () => {
    const { wallet } = await loggedIn('arc', { approveLost: true });
    expect(code(await wallet.cancel('t-9').catch(e => e))).toBe('outcome_unknown');
  });
});

describe('transfer', () => {
  const TO = '0x30ABfbE1Ae448515d2671D9E3C02f5Bf437d8048';
  it('sends USDC as a Circle transaction and returns the hash once Circle says it is confirmed', async () => {
    const { wallet, circle } = await loggedIn();
    await expect(wallet.transfer({ to: TO, amount: '0.01' })).resolves.toEqual({ hash: MINED, transactionId: 't-9' });
    expect(circle.seen.transfer).toMatchObject({ walletId: 'w-arc', sourceAddress: WALLETS.arc.address, destinationAddress: TO, amounts: ['0.01'],
      blockchain: 'ARC-TESTNET', tokenAddress: ARC_USDC, feeLevel: 'MEDIUM' });
    expect(circle.seen.transfer.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });
  it.each([['amount', { to: TO, amount: '1e3' }], ['amount', { to: TO, amount: '0' }], ['address', { to: '0x1234', amount: '1' }]] as const)(
    'refuses a bad %s without calling Circle', async (_what, bad) => {
      const { wallet, circle } = await loggedIn();
      expect(code(await wallet.transfer(bad).catch(e => e))).toBe('invalid_input');
      expect(circle.calls).toEqual([]);
    });
  it("names Circle's spending limit when it refuses the transfer", async () => {
    const { wallet } = await loggedIn('arc', { overLimit: true });
    expect(code(await wallet.transfer({ to: TO, amount: '0.01' }).catch(e => e))).toBe('limit_exceeded');
  });
});

describe('fund', () => {
  it("asks Circle's testnet faucet for USDC to the wallet, or the token named", async () => {
    const { wallet, circle } = await loggedIn();
    await wallet.fund();
    expect(circle.seen.fund).toEqual({ address: WALLETS.arc.address, blockchain: 'ARC-TESTNET', token: 'usdc' });
    await wallet.fund('eurc');
    expect(circle.seen.fund.token).toBe('eurc');
  });
  it('says there is no faucet on mainnet, without calling Circle', async () => {
    const { wallet, circle } = await loggedIn('base');
    expect(code(await wallet.fund().catch(e => e))).toBe('invalid_input');
    expect(circle.calls).toEqual([]);
  });
});

describe('searchServices', () => {
  it("asks Circle's marketplace with no session and trims each service to what an app shows", async () => {
    let asked = ''; let sent: RequestInit | undefined;
    const answer = { x402Version: 2, items: [{ resource: 'https://seller.example/paid', type: 'http', metadata: { provider: { name: 'Seller', category: 'food' }, method: 'GET', description: 'A paid thing' },
      accepts: [{ amount: '10000', network: 'eip155:8453', extra: { name: 'USDC' } }] }, { broken: true }] };
    const found = await searchServices({ query: 'restaurants', limit: 5 }, (async (input: string | URL | Request, init?: RequestInit) => { asked = String(input); sent = init; return new Response(JSON.stringify(answer)); }) as typeof fetch);
    expect(asked).toBe('https://api.circle.com/v2/x402/discovery/resources?query=restaurants&limit=5&siwx=false');
    expect(sent?.headers).toBeUndefined();
    expect(found).toEqual([{ url: 'https://seller.example/paid', method: 'GET', description: 'A paid thing', provider: 'Seller', accepts: [{ amount: '10000', network: 'eip155:8453' }] }]);
  });
  it('fails loud when Circle answers with something else', async () => {
    expect(code(await searchServices({}, (async () => new Response('{"items":null}')) as typeof fetch).catch(e => e))).toBe('protocol');
    expect(code(await searchServices({}, (async () => new Response('no', { status: 503 })) as typeof fetch).catch(e => e))).toBe('http');
  });
});

describe('limits', () => {
  const CAP = { perTx: '0.005', daily: '0.01', weekly: '0.05', monthly: '0.1' };
  const custom = { policyType: 'STABLECOIN_TRANSFER', ruleType: 'TRANSFER_LIMIT', blockchain: 'BASE', ...CAP, addresses: [], origin: 'CUSTOM', id: 'p-1' };
  const byDefault = { policyType: 'STABLECOIN_TRANSFER', ruleType: 'TRANSFER_LIMIT', blockchain: null, perTx: null, daily: null, weekly: null, monthly: '100', addresses: [], origin: 'DEFAULT', id: null };
  it("reads Circle's limits and what is left of them with the agent's own session, an empty limit meaning none", async () => {
    const { wallet } = await loggedIn('base', { customLimit: true });
    expect(await wallet.limits.read()).toEqual([custom]);
    expect(await wallet.limits.budget()).toEqual([{ policyType: 'STABLECOIN_TRANSFER', perTx: null, daily: null, dailyRemaining: null, weekly: null, weeklyRemaining: null,
      monthly: '100', monthlyRemaining: '99.97', origin: 'DEFAULT' }]);
  });
  it('says limits exist on mainnet only, without calling Circle', async () => {
    const { wallet, circle } = await loggedIn('arc');
    for (const ask of [() => wallet.limits.read(), () => wallet.limits.budget(), () => wallet.limits.owner.start(EMAIL), () => wallet.limits.set(CAP), () => wallet.limits.reset()])
      expect(code(await ask().catch(e => e))).toBe('invalid_input');
    expect(circle.calls).toEqual([]);
  });
  it('changes nothing without an owner login, which the agent session cannot stand in for', async () => {
    const { wallet, circle } = await loggedIn('base');
    expect(code(await wallet.limits.set(CAP).catch(e => e))).toBe('not_logged_in');
    expect(code(await wallet.limits.reset().catch(e => e))).toBe('not_logged_in');
    expect(circle.calls).toEqual([]);
  });
  it("sets a limit with the owner's token from a second emailed code, refuses to replace one, and resets to Circle's default", async () => {
    const { wallet, circle, storage } = await loggedIn('base');
    expect(await wallet.limits.owner.start(EMAIL)).toEqual({ codePrefix: HEAD });
    await wallet.limits.owner.finish(CODE);
    // The owner login creates no wallets, looks none up, and leaves the stored agent session as it was.
    expect(circle.calls.every(call => call.startsWith('owner ') && !/initialize|wallets/.test(call))).toBe(true);
    expect(await storage.get(KEY.base)).toBe(saved.base);
    expect(await storage.get(KEY.base)).not.toContain(OWNER_TOKEN);

    await wallet.limits.set(CAP);
    expect(circle.seen.policy).toEqual({ wallet_id: 'w-base', blockchain: 'BASE', policy_type: 'STABLECOIN_TRANSFER', rule_type: 'TRANSFER_LIMIT',
      params: { per_tx: '0.005', daily: '0.01', weekly: '0.05', monthly: '0.1' } });
    expect(await wallet.limits.read()).toEqual([custom]);
    const again = await wallet.limits.set({ ...CAP, monthly: '1' }).catch(e => e);
    expect(code(again)).toBe('invalid_input');
    expect(again.message).toContain('limits.reset()');
    expect(await wallet.limits.read()).toEqual([custom]);
    await wallet.limits.reset();
    expect(await wallet.limits.read()).toEqual([byDefault]);
    await wallet.limits.reset(); // nothing custom left: nothing to delete
  }, 120_000);
  it.each([{ ...CAP, daily: '0.001' }, { ...CAP, perTx: '1e-3' }, { ...CAP, monthly: '' }])('refuses limits that are not decimals in rising order, before asking Circle: %o', async bad => {
    const { wallet, circle } = await loggedIn('base');
    expect(code(await wallet.limits.set(bad).catch(e => e))).toBe('invalid_input');
    expect(circle.calls).toEqual([]);
  });
  it('restricts contracts and recipients with lists, each removable alone', async () => {
    const { wallet, circle } = await loggedIn('base');
    await wallet.limits.owner.start(EMAIL); await wallet.limits.owner.finish(CODE);
    await wallet.limits.set(CAP);
    const SELLER = '0xF46F48677E11aae0f3354aa69b2fa10c8fd8dbe8';
    await wallet.limits.setList('contract-allowlist', [SELLER, SELLER.toLowerCase(), BASE_USDC]);
    expect(circle.seen.policy).toEqual({ wallet_id: 'w-base', blockchain: 'BASE', policy_type: 'CONTRACT_INTERACTION', rule_type: 'CONTRACT_ALLOWLIST',
      params: { addresses: [SELLER.toLowerCase(), BASE_USDC.toLowerCase()] } });
    await wallet.limits.setList('recipient-blocklist', [SELLER]);
    expect(circle.seen.policy).toMatchObject({ policy_type: 'STABLECOIN_TRANSFER', rule_type: 'RECIPIENT_BLOCKLIST' });
    expect(code(await wallet.limits.setList('recipient-blocklist', [BASE_USDC]).catch(e => e))).toBe('invalid_input'); // one of each: reset it first

    const rules = await wallet.limits.read();
    const allow = rules.find(rule => rule.ruleType === 'CONTRACT_ALLOWLIST')!;
    expect(allow).toMatchObject({ policyType: 'CONTRACT_INTERACTION', addresses: [SELLER.toLowerCase(), BASE_USDC.toLowerCase()], origin: 'CUSTOM' });
    await wallet.limits.reset(allow.id!);
    expect((await wallet.limits.read()).map(rule => rule.ruleType).sort()).toEqual(['RECIPIENT_BLOCKLIST', 'TRANSFER_LIMIT']);
    await wallet.limits.reset();
    expect(await wallet.limits.read()).toEqual([byDefault]);
  }, 120_000);
  it.each([[['0x1234']], [[]]])('refuses a list that is empty or holds something that is not an address, before asking Circle: %j', async addresses => {
    const { wallet, circle } = await loggedIn('base');
    expect(code(await wallet.limits.setList('contract-allowlist', addresses).catch(e => e))).toBe('invalid_input');
    expect(circle.calls).toEqual([]);
  });
  it('says so when asked to remove a rule that is not there, and lets the app end the owner login early', async () => {
    const { wallet, circle } = await loggedIn('base', { customLimit: true });
    await wallet.limits.owner.start(EMAIL); await wallet.limits.owner.finish(CODE);
    expect(code(await wallet.limits.reset('no-such-rule').catch(e => e))).toBe('invalid_input');
    expect(circle.calls.some(call => call.startsWith('DELETE'))).toBe(false);
    wallet.limits.owner.end();
    expect(code(await wallet.limits.reset().catch(e => e))).toBe('not_logged_in');
  }, 120_000);
  it('forgets the owner login after ten minutes, and at logout', async () => {
    const { wallet, circle } = await loggedIn('base');
    await wallet.limits.owner.start(EMAIL); await wallet.limits.owner.finish(CODE);
    delete circle.seen.deviceId; // a new login is a new device to Circle
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60_000 + 1);
    try { expect(code(await wallet.limits.set(CAP).catch(e => e))).toBe('not_logged_in'); } finally { clock.mockRestore(); }
    await wallet.limits.owner.start(EMAIL); await wallet.limits.owner.finish(CODE);
    await wallet.logout();
    expect(code(await wallet.limits.set(CAP).catch(e => e))).toBe('not_logged_in');
  }, 120_000);
});

describe('logout', () => {
  it.each(['local', 'all'] as const)('revokes the session at Circle with scope %s, then removes it from storage', async scope => {
    const { wallet, circle, storage } = await loggedIn();
    await wallet.logout(scope);
    expect(circle.calls).toEqual(['POST /v1/w3s/users/token/deactivate']);
    expect(circle.seen.deactivate).toEqual({ idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/), scope });
    expect(await storage.get(KEY.arc)).toBeNull();
    expect(await wallet.session()).toBeNull();
  });
  it('defaults to this device only', async () => {
    const { wallet, circle } = await loggedIn();
    await wallet.logout();
    expect(circle.seen.deactivate.scope).toBe('local');
  });
  it('keeps the session when Circle does not confirm, so the logout can be retried; forget() removes it regardless', async () => {
    const { wallet, storage } = await loggedIn('arc', { deactivate: 503 });
    expect(code(await wallet.logout().catch(e => e))).toBe('http');
    expect(await storage.get(KEY.arc)).toBe(saved.arc);
    await wallet.forget();
    expect(await storage.get(KEY.arc)).toBeNull();
  });
  // 403 is what Circle answered a revoked session on Arc testnet (23 Nov 2026, the balance call); 401 is the usual answer to a bad token.
  it('removes a session Circle no longer accepts (401 or 403), and an expired one without calling Circle', async () => {
    for (const status of [401, 403]) {
      const refused = await loggedIn('arc', { deactivate: status });
      await refused.wallet.logout();
      expect(await refused.storage.get(KEY.arc)).toBeNull();
    }
    const expired = await loggedIn('arc', undefined, JSON.stringify({ ...JSON.parse(saved.arc), expiresAt: 1 }));
    await expired.wallet.logout();
    expect(expired.circle.calls).toEqual([]);
    expect(await expired.storage.get(KEY.arc)).toBeNull();
  });
});

describe('keychainStorage', () => {
  it('keeps each value as a generic password readable only on this device while it is unlocked', async () => {
    const items = new Map<string, string>(); const options: any[] = [];
    const Keychain = {
      ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly' },
      getGenericPassword: async ({ service }: { service: string }) => (items.has(service) ? { username: 'x', password: items.get(service)! } : false as const),
      setGenericPassword: async (_name: string, value: string, o: { service: string }) => { options.push(o); if (value === 'full') return false as const; items.set(o.service, value); return { service: o.service }; },
      resetGenericPassword: async ({ service }: { service: string }) => items.delete(service),
    };
    const storage: Storage = keychainStorage(Keychain);
    expect(await storage.get('k')).toBeNull();
    await storage.set('k', 'v');
    expect(options[0]).toEqual({ service: 'k', accessible: 'AccessibleWhenUnlockedThisDeviceOnly' });
    expect(await storage.get('k')).toBe('v');
    await expect(storage.set('k', 'full')).rejects.toThrow('Keychain did not save'); // a session that was not kept must not look kept
    await storage.remove('k');
    expect(await storage.get('k')).toBeNull();
  });
});

// A seller that asks 0.01 USDC on Arc testnet over x402 v2, and records the payment it is handed.
const PAY_TO = '0x30ABfbE1Ae448515d2671D9E3C02f5Bf437d8048';
const terms: Terms = { network: 'eip155:5042002', asset: ARC_USDC, name: 'USDC', version: '2', maxAmount: 10000n, payTo: PAY_TO };
function seller() {
  const url = 'https://seller.example/lookup';
  const paid: any[] = [];
  const fetch = async (_input: string | URL | Request, init: RequestInit = {}) => {
    const header = new Headers(init.headers).get('payment-signature');
    if (!header) return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader({ x402Version: 2, resource: { url, description: 'lookup', mimeType: 'application/json' },
      accepts: [{ scheme: 'exact', network: 'eip155:5042002', asset: ARC_USDC, amount: '10000', payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } }] }) } });
    paid.push(decodePaymentSignatureHeader(header));
    return new Response(JSON.stringify({ answer: 42 }), { status: 200, headers: { 'content-type': 'application/json',
      'PAYMENT-RESPONSE': encodePaymentResponseHeader({ success: true, transaction: MINED, network: 'eip155:5042002' }) } });
  };
  return { url, paid, fetch: fetch as typeof globalThis.fetch };
}

describe('the checks a 402 must pass before anything is signed', () => {
  const offer = { scheme: 'exact', network: 'eip155:5042002', asset: ARC_USDC, amount: '10000', payTo: PAY_TO, maxTimeoutSeconds: 120, extra: { name: 'USDC', version: '2' } };
  it('passes the offer the app agreed to, whatever the case of its addresses', () => {
    expect(() => checkRequirement(offer, terms)).not.toThrow();
    expect(() => checkRequirement({ ...offer, payTo: PAY_TO.toLowerCase(), asset: ARC_USDC.toUpperCase().replace('0X', '0x') }, terms)).not.toThrow();
  });
  it.each([
    ['scheme', { scheme: 'upto' }], ['network', { network: 'eip155:8453' }], ['asset', { asset: BASE_USDC }],
    ['token domain', { extra: { name: 'USD Coin', version: '2' } }], ['token domain', { extra: { name: 'USDC', version: '1' } }],
    ['transfer method', { extra: { name: 'USDC', version: '2', assetTransferMethod: 'permit2' } }],
    ['amount', { amount: '10001' }], ['amount', { amount: '0' }], ['amount', { amount: '0x10' }], ['amount', { amount: ' 1' }],
    ['payTo', { payTo: '0x2222222222222222222222222222222222222222' }], ['timeout', { maxTimeoutSeconds: 86_400 * 30 }],
    ['timeout', { maxTimeoutSeconds: 'abc' as unknown as number }],
  ] as const)('refuses another %s: %j', (field, change) => {
    expect(() => checkRequirement({ ...offer, ...change }, terms)).toThrow(`Refused to pay: ${field}`);
  });
});

describe('paying an x402 resource', () => {
  it('lets the app allow a longer validity than the default hour', () => {
    const day = { scheme: 'exact', network: 'eip155:5042002', asset: ARC_USDC, amount: '10000', payTo: PAY_TO, maxTimeoutSeconds: 86_400, extra: { name: 'USDC', version: '2' } };
    expect(() => checkRequirement(day, terms)).toThrow('Refused to pay: timeout');
    expect(() => checkRequirement(day, { ...terms, maxTimeoutSeconds: 86_400 })).not.toThrow();
  });
  it('says a payment was signed when the paid request never comes back, or comes back unreadable', async () => {
    const { wallet } = await loggedIn(); const s = seller();
    const answering = (answer: () => Promise<Response>) => (async (input: string | URL | Request, init: RequestInit = {}) =>
      (new Headers(init.headers).get('payment-signature') ? answer() : s.fetch(input, init))) as typeof fetch;
    await expect(payOnce(s.url, await wallet.x402Signer(), terms, answering(async () => { throw new TypeError('network down'); }))).rejects.toThrow('A payment was signed');
    await expect(payOnce(s.url, await wallet.x402Signer(), terms, answering(async () => new Response('<html>', { status: 200 })))).rejects.toThrow('A payment was signed');
  });
  it('says a payment was signed when the seller then fails, so the app does not treat it as unpaid', async () => {
    const { wallet } = await loggedIn(); const s = seller();
    const failing = (async (input: string | URL | Request, init: RequestInit = {}) =>
      (new Headers(init.headers).get('payment-signature') ? new Response('oops', { status: 500 }) : s.fetch(input, init))) as typeof fetch;
    await expect(payOnce(s.url, await wallet.x402Signer(), terms, failing)).rejects.toThrow('A payment was signed');
  });
  it('has Circle sign the EIP-3009 transfer once the 402 passes the checks', async () => {
    const { wallet, circle } = await loggedIn(); const s = seller();
    await expect(payOnce(s.url, await wallet.x402Signer(), terms, s.fetch)).resolves.toEqual({ body: { answer: 42 }, transaction: MINED });
    expect(s.paid[0].payload).toMatchObject({ signature: SIGNATURE, authorization: { from: WALLETS.arc.address, to: PAY_TO, value: '10000' } });
    expect(circle.seen.typedData).toMatchObject({ primaryType: 'TransferWithAuthorization', domain: { name: 'USDC', version: '2', chainId: 5042002, verifyingContract: ARC_USDC },
      message: { to: PAY_TO, value: '10000' } });
  });
  it("passes Circle's spending-limit refusal through as it is, so an app can tell it from its own", async () => {
    const { wallet } = await loggedIn('arc', { overLimit: true }); const s = seller();
    expect(code(await payOnce(s.url, await wallet.x402Signer(), terms, s.fetch).catch(e => e))).toBe('limit_exceeded');
    expect(s.paid).toHaveLength(0);
  });
  // Payee and network are the app's own check; an amount over the cap is refused by the x402 client's spend controls, earlier still.
  it.each([
    ['payee', { ...terms, payTo: '0x2222222222222222222222222222222222222222' }, 'Refused to pay: payTo'],
    ['token domain', { ...terms, name: 'USD Coin' }, 'Refused to pay: token domain'],
    ['network', { ...terms, network: 'eip155:1' }, 'Refused to pay'],
    ['amount', { ...terms, maxAmount: 9999n }, 'Refused to pay'],
  ] as const)('sends nothing to Circle and signs nothing when the 402 has another %s', async (_field, wanted, reason) => {
    const { wallet, circle } = await loggedIn(); const s = seller();
    await expect(payOnce(s.url, await wallet.x402Signer(), wanted, s.fetch)).rejects.toThrow(reason);
    expect(circle.calls).toEqual([]);
    expect(s.paid).toHaveLength(0);
  });
});
