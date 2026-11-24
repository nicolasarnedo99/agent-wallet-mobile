// An unofficial client for Circle Agent Wallets, over the API that Circle's CLI 1.4.0 uses: Circle's proxy adds the API key, so
// this client holds none. Every signature is a challenge the client approves with a PIN derived from the user secret Circle
// returns at login, so the session is the whole credential. The protocol is written up in docs/PROTOCOL.md; its logic is ported
// from @circle-fin/cli (Apache-2.0, see NOTICE).
//
// Runtime needs, all present in React Native and Node: fetch, crypto.getRandomValues, btoa/atob, TextEncoder, setTimeout.
import forge from 'node-forge';
import { gcm } from '@noble/ciphers/aes.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { getTypesForEIP712Domain } from 'viem';
import { toAccount, type LocalAccount } from 'viem/accounts';

// Circle keeps testnet and mainnet apart: each has its own proxy, login and wallets, so a session belongs to one network.
export type Network = 'arc' | 'base';
export const NETWORKS = {
  arc: { proxy: 'https://agentic-wallet.circle.com/proxy/test', blockchain: 'ARC-TESTNET', chainId: 5042002, usdc: '0x3600000000000000000000000000000000000000' },
  base: { proxy: 'https://agentic-wallet.circle.com/proxy/live', blockchain: 'BASE', chainId: 8453, usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
} as const;
// The chains a first login creates wallets on, by network: the CLI's own lists (chain-map.ts).
const FIRST_LOGIN_CHAINS = { arc: ['ETH-SEPOLIA', 'MATIC-AMOY', 'ARB-SEPOLIA', 'AVAX-FUJI', 'OP-SEPOLIA', 'BASE-SEPOLIA', 'UNI-SEPOLIA', 'MONAD-TESTNET', 'ARC-TESTNET'],
  base: ['ETH', 'MATIC', 'ARB', 'AVAX', 'OP', 'BASE', 'UNI', 'MONAD', 'ARC'] };
// The approval's device info is the CLI's own, the only value known to pass; a phone's own values were not tried.
const DEVICE = { os: { model: '', version: '' }, browser: { model: 'WebSDK', version: '' }, device: { model: 'Desktop', version: '' }, sdk: { model: 'Web', version: '' } };

type Hex = `0x${string}`;
// Everything needed to sign for the wallet until expiresAt: treat the whole object as a secret. The user secret is sealed under
// storageKey, which sits beside it: that is no protection at rest (the storage is), but the secret never shows up in a printed session.
export type Session = { network: Network; deviceId: string; appId: string; userToken: string; encryptionKey: string; encryptedUserSecret: string;
  storageKey: string; expiresAt: number; walletId: string; address: Hex };
export type WalletInfo = { network: Network; id: string; address: Hex; blockchain: string; expiresAt: number };
export type TypedData = { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };
// The shape @x402/evm's ClientEvmSigner needs, declared here so this package does not depend on x402.
export type X402Signer = { readonly address: Hex; signTypedData(data: TypedData): Promise<Hex> };
export type TransactionStatus = { id: string; state: string; hash: Hex | null; errorReason: string | null };
// One paid resource from Circle's Agent Marketplace; `accepts` lists what it charges, in base units, on which network.
export type Service = { url: string; method: string | null; description: string | null; provider: string | null; accepts: { amount: string; network: string }[] };
// One of Circle's spending rules on the wallet. Amounts are decimal strings in whole tokens; null means no cap in that window.
// `origin` is DEFAULT for Circle's own rule and CUSTOM for one the owner set; only a custom rule has an id.
export type Limit = { policyType: string; ruleType: string; blockchain: string | null; perTx: string | null; daily: string | null; weekly: string | null;
  monthly: string | null; addresses: string[]; origin: string; id: string | null };
export type Budget = { policyType: string; perTx: string | null; daily: string | null; dailyRemaining: string | null; weekly: string | null; weeklyRemaining: string | null;
  monthly: string | null; monthlyRemaining: string | null; origin: string };
export type Storage = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };

export type ErrorCode = 'not_logged_in' | 'session_expired' | 'wrong_code' | 'invalid_input' | 'http' | 'protocol' | 'transaction_failed' | 'limit_exceeded' | 'not_allowed' | 'outcome_unknown';
export class AgentWalletError extends Error {
  // `status` is Circle's HTTP status, on `http` errors only.
  constructor(readonly code: ErrorCode, message: string, readonly status?: number) { super(message); this.name = 'AgentWalletError'; }
}
const broken = (message: string) => new AgentWalletError('protocol', message);

export const isExpired = (session: Pick<Session, 'expiresAt'>, now = Date.now()) => now >= session.expiresAt;

// Lost when the process ends: for tests and scripts. On a phone use keychainStorage.
export function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return { get: async key => items.get(key) ?? null, set: async (key, value) => { items.set(key, value); }, remove: async key => { items.delete(key); } };
}
// The session in the iOS Keychain or Android Keystore, through react-native-keychain (10.x), passed in so this package does not
// depend on it: keychainStorage(Keychain) after `import * as Keychain from 'react-native-keychain'`. Readable only while the device
// is unlocked, and never copied to a backup or another device.
type KeychainModule = {
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: unknown };
  getGenericPassword(options: any): Promise<false | { password: string }>;
  setGenericPassword(username: string, password: string, options: any): Promise<unknown>;
  resetGenericPassword(options: any): Promise<unknown>;
};
export function keychainStorage(Keychain: KeychainModule): Storage {
  return {
    get: async key => { const found = await Keychain.getGenericPassword({ service: key }); return found ? found.password : null; },
    set: async (key, value) => {
      const kept = await Keychain.setGenericPassword('circle-agent-wallet', value, { service: key, accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
      if (kept === false) throw new Error('The Keychain did not save the session');
    },
    remove: async key => { await Keychain.resetGenericPassword({ service: key }); },
  };
}

const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const bytes = (text: string) => new TextEncoder().encode(text);
const latin1 = (text: string) => Uint8Array.from(text, c => c.charCodeAt(0) & 0xff);
const binary = (data: Uint8Array) => String.fromCharCode(...data); // forge's byte strings
const utf8 = (data: Uint8Array) => decodeURIComponent(Array.from(data, b => `%${b.toString(16).padStart(2, '0')}`).join(''));
const b64 = (data: Uint8Array) => btoa(binary(data));
const unb64 = (text: string) => latin1(atob(text));
const hex = (data: Uint8Array) => Array.from(data, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function uuid(): string {
  const b = random(16); b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = hex(b).toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
// AES-256-GCM as Circle frames it: base64(12-byte IV ‖ ciphertext ‖ tag).
const seal = (key: string, plain: Uint8Array) => { const iv = random(12); const sealed = gcm(unb64(key), iv).encrypt(plain);
  const out = new Uint8Array(12 + sealed.length); out.set(iv); out.set(sealed, 12); return b64(out); };
const open = (key: string, text: string) => { const data = unb64(text); return gcm(unb64(key), data.subarray(0, 12)).decrypt(data.subarray(12)); };
const sealJson = (key: string, value: unknown) => seal(key, bytes(JSON.stringify(value)));
const openJson = (key: string, text: string) => JSON.parse(utf8(open(key, text)));
const oaep = () => ({ md: forge.md.sha256.create(), mgf1: { md: forge.md.sha256.create() } });
function jwtPayload(token: string): any {
  try {
    const part = token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(utf8(unb64(part.padEnd(Math.ceil(part.length / 4) * 4, '='))));
  } catch { return null; }
}

type Fetch = typeof fetch;
// `quiet` leaves Circle's own message out of errors: during a login it could echo the email or the code.
// `base` replaces the network's proxy: Circle's limits are served from the service root, and their owner logs in through a proxy of its own.
type Target = { network: Network; quiet?: boolean; base?: string };
const ROOT = 'https://agentic-wallet.circle.com';
const OWNER_PROXY = `${ROOT}/proxy/live-user`; // mainnet only: there is no testnet counterpart
type Who = Target & { appId: string; deviceId: string };

// Only the status, Circle's numeric code and (outside a login) its short message are kept: a body could echo credentials.
type Method = 'GET' | 'POST' | 'DELETE';
async function request(f: Fetch, on: Target, method: Method, path: string, headers: Record<string, string>, body?: string): Promise<any> {
  const response = await f(`${on.base ?? NETWORKS[on.network].proxy}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body }) });
  const text = await response.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  if (!response.ok) throw new AgentWalletError('http', `Circle ${method} ${path.split('?')[0]} answered ${response.status}${typeof json?.code === 'number' ? ` (code ${json.code})` : ''}${
    !on.quiet && typeof (json?.message ?? json?.error) === 'string' ? `: ${String(json.message ?? json.error).slice(0, 120)}` : ''}`, response.status);
  return json ?? {};
}
async function plain(f: Fetch, on: Target, method: Method, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}): Promise<any> {
  const json = await request(f, on, method, path, { ...(token ? { 'X-User-Token': token } : {}), ...headers }, body === undefined ? undefined : JSON.stringify(body));
  return json.data ?? json;
}
// The /sdk/ calls carry the app and device, and an encrypted body both ways (an approval may come back with none).
async function sdkCall(f: Fetch, who: Who, token: string, method: 'GET' | 'POST', path: string, body?: string): Promise<string | undefined> {
  const json = await request(f, who, method, path, { 'X-App-Id': who.appId, 'X-Device-Id': who.deviceId, Authorization: `Bearer ${token}`, 'X-User-Token': token }, body);
  return typeof json.data?.encrypt === 'string' ? json.data.encrypt : undefined;
}
async function sdk(f: Fetch, who: Who, token: string, method: 'GET' | 'POST', path: string, body?: string): Promise<string> {
  const encrypted = await sdkCall(f, who, token, method, path, body);
  if (encrypted === undefined) throw broken(`Circle ${method} ${path} sent no encrypted answer`);
  return encrypted;
}

// The throwaway RSA-2048 key Circle wraps the login's OTP token to. Pure JS takes seconds on a phone, so it is made in 50 ms slices
// with a timer between them. Do not swap this for forge's own async generation: that chains setImmediate, which React Native 0.88
// runs as a microtask, so the UI never got a turn and the app froze until the key was done. setTimeout always yields to the event loop.
type LoginKeys = { publicKey: string; privateKey: forge.pki.rsa.PrivateKey };
type Stepper = { createKeyPairGenerationState(bits: number, e: number, options: object): { keys?: forge.pki.rsa.KeyPair };
  stepKeyPairGenerationState(state: object, ms: number): boolean };
function loginKeys(): Promise<LoginKeys> {
  const rsa = forge.pki.rsa as unknown as Stepper; // in forge, missing from its types
  const state = rsa.createKeyPairGenerationState(2048, 0x10001, { prng: { getBytesSync: (n: number) => binary(random(n)) } });
  return new Promise((resolve, reject) => {
    const step = () => {
      try {
        if (!rsa.stepKeyPairGenerationState(state, 50)) { setTimeout(step, 0); return; }
        resolve({ publicKey: forge.pki.publicKeyToPem(state.keys!.publicKey).replace(/\r\n/g, '\n'), privateKey: state.keys!.privateKey });
      } catch (error) { reject(error); }
    };
    setTimeout(step, 0);
  });
}

const AES_GCM_OID = '60864801650304012E';
const ENVELOPE_OID = '2A864886F70D01010B';
// Circle's DER envelope: [0] version 0, [1] the token sealed under an AES key, [2] that key wrapped to ours, [3] and [4] the algorithms.
function openEnvelope(envelope: string, privateKey: forge.pki.rsa.PrivateKey): string {
  const root = forge.asn1.fromDer(atob(envelope));
  const fields = root.value as forge.asn1.Asn1[];
  if (!Array.isArray(fields) || fields.length !== 5 || fields.some((field, i) => field.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC || (field.type as number) !== i)
    || fields[0]!.value !== '\x00' || hex(latin1(fields[3]!.value as string)) !== AES_GCM_OID || hex(latin1(fields[4]!.value as string)) !== ENVELOPE_OID)
    throw broken('Circle sent a login envelope this client cannot read');
  const key = privateKey.decrypt(fields[2]!.value as string, 'RSA-OAEP', oaep());
  return utf8(open(btoa(key), btoa((fields[1]!.value as forge.asn1.Asn1[])[0]!.value as string)));
}

// Held in memory between login.start and login.finish, never stored: it carries the email and the OTP token.
type PendingLogin = Who & { email: string; deviceToken: string; deviceEncryptionKey: string; challengeId: string; correlationState: string; factorIndex: number;
  otpToken: string; otpHead?: string; firstLogin: boolean;
  accepted?: any }; // Circle's answer once it has taken the code: a code works once, so a retry must start from here

// Circle emails the code. Throws, before the code is asked for, at an account the Circle CLI has not set up yet.
async function startLogin(f: Fetch, network: Network, email: string, keys: LoginKeys, base?: string): Promise<PendingLogin> {
  const on: Target = { network, quiet: true, ...(base ? { base } : {}) };
  const deviceId = uuid();
  const device = await plain(f, on, 'POST', '/v1/w3s/auth/deviceToken', undefined, { idempotencyKey: uuid(), deviceId });
  if (typeof device.deviceToken !== 'string' || typeof device.deviceEncryptionKey !== 'string') throw broken('Circle sent no device credentials');
  const challenge = await plain(f, on, 'POST', '/v1/w3s/auth/challenges', device.deviceToken, { idempotencyKey: uuid(), operation: 'login',
    registeredFactors: [{ factor: 'email_otp', emailOtp: { destination: email, suite: 'RSA_OAEP_256_A256GCM', publicKey: keys.publicKey } }] });
  const firstLogin = challenge.operation === 'bootstrap'; // a first login also creates the wallets, in finishLogin
  if ((!firstLogin && challenge.operation !== 'login') || typeof challenge.challengeId !== 'string' || typeof challenge.correlationState !== 'string')
    throw broken('Circle answered the login with an unexpected challenge');
  const { appId } = await plain(f, on, 'GET', '/config');
  if (typeof appId !== 'string') throw broken('Circle sent no app id');
  const who: Who = { ...on, appId, deviceId };
  const sent = openJson(device.deviceEncryptionKey, await sdk(f, who, device.deviceToken, 'GET', `/v1/w3s/sdk/auth/challenges/${challenge.challengeId}`));
  const factorIndex = Array.isArray(sent.requiredFactors) ? sent.requiredFactors.findIndex((factor: any) => factor?.factor === 'email_otp') : -1;
  const wrapped = sent.requiredFactors?.[factorIndex]?.emailOtpParameters?.encryptedOtpToken;
  if (sent.challengeId !== challenge.challengeId || typeof wrapped !== 'string') throw broken('Circle sent no email code factor');
  const otpToken = openEnvelope(wrapped, keys.privateKey);
  const otpHead = jwtPayload(otpToken)?.otpHead;
  return { ...who, email, deviceToken: device.deviceToken, deviceEncryptionKey: device.deviceEncryptionKey, challengeId: challenge.challengeId,
    correlationState: challenge.correlationState, factorIndex, otpToken, firstLogin, ...(typeof otpHead === 'string' && otpHead.trim() ? { otpHead: otpHead.trim() } : {}) };
}

// Circle's codes read "ABC-123456"; the email's letters are in the OTP token, so six digits are enough to type.
function fullCode(typed: string, head?: string): string {
  const invalid = (message: string) => new AgentWalletError('invalid_input', message);
  const code = typed.trim();
  if (/^\d{6}$/.test(code)) {
    if (!head) throw invalid('Type the whole code from the email, letters included');
    return `${head}-${code}`;
  }
  const match = /^([A-Za-z0-9]+)-(\d{6})$/.exec(code);
  if (!match) throw invalid('The code is six digits');
  if (head && match[1]!.toUpperCase() !== head.toUpperCase()) throw invalid('That code is not the one from the latest email');
  return `${head ?? match[1]!.toUpperCase()}-${match[2]}`;
}

// The code goes into one encrypted request and nowhere else. Circle's answer, once it has confirmed the login.
async function submitCode(f: Fetch, pending: PendingLogin, typed: string): Promise<any> {
  let done = pending.accepted;
  if (!done) try {
    const code = fullCode(typed, pending.otpHead);
    done = openJson(pending.deviceEncryptionKey, await sdk(f, pending, pending.deviceToken, 'POST', `/v1/w3s/sdk/auth/challenges/${pending.challengeId}/factors`,
      sealJson(pending.deviceEncryptionKey, { idempotencyKey: uuid(), factorSubmissions: [{ requiredFactorIndex: pending.factorIndex,
        emailOtpProof: { destination: pending.email, otpToken: pending.otpToken, code } }] })));
  } catch (error) {
    if (error instanceof AgentWalletError && (error.status === 400 || error.status === 401)) throw new AgentWalletError('wrong_code', 'Wrong or expired code: ask for a new one', error.status);
    throw error;
  }
  if (String(done.state).toLowerCase() !== 'completed' || typeof done.userToken !== 'string' || !done.userToken) throw broken('Circle did not complete the login');
  pending.accepted = done;
  // Circle confirms the challenge a moment after it completes, so not-yet and 5xx are retried as the CLI does; a 4xx is final.
  let confirmed = false;
  for (const wait of [0, 400, 1200, 2800]) {
    await sleep(wait);
    try {
      const state = await plain(f, pending, 'GET', `/v1/w3s/auth/challenges/${pending.challengeId}`, pending.deviceToken, undefined, { 'X-Correlation-State': pending.correlationState });
      if (String(state.state).toLowerCase() === 'completed') { confirmed = true; break; }
    } catch (error) {
      if (error instanceof AgentWalletError && error.status !== undefined && error.status < 500) throw error;
    }
  }
  if (!confirmed) throw broken('Circle did not confirm the login');
  return done;
}

async function finishLogin(f: Fetch, pending: PendingLogin, typed: string): Promise<Session> {
  const done = await submitCode(f, pending, typed);
  if (['encryptionKey', 'userSecret', 'storageKey'].some(field => typeof done[field] !== 'string' || !done[field])) throw broken('Circle did not complete the login');
  const exp = jwtPayload(done.userToken)?.exp;
  if (typeof exp !== 'number') throw broken('Circle sent a session with no expiry');
  const { blockchain } = NETWORKS[pending.network];
  const session = { network: pending.network, deviceId: pending.deviceId, appId: pending.appId, userToken: done.userToken, encryptionKey: done.encryptionKey,
    encryptedUserSecret: seal(done.storageKey, bytes(done.userSecret)), storageKey: done.storageKey, expiresAt: exp * 1000 };
  // A first login: Circle creates a wallet on each chain, behind a challenge approved like a signature. Unlike the CLI, a creation
  // that fails or never finishes is an error here, so no session is kept for an account that has no wallet.
  if (pending.firstLogin) {
    const created = await plain(f, pending, 'POST', '/v1/w3s/user/initialize', done.userToken, { idempotencyKey: uuid(), accountType: 'SCA', blockchains: FIRST_LOGIN_CHAINS[pending.network] })
      .catch(error => { if (error instanceof AgentWalletError && error.status === 409) return null; throw error; }); // 409: already set up
    if (created) {
      if (typeof created.challengeId !== 'string') throw broken('Circle sent no wallet creation challenge');
      await approve(f, { ...session, walletId: '', address: '0x' }, created.challengeId);
      const { challenge } = await poll(() => plain(f, pending, 'GET', `/v1/w3s/user/challenges/${created.challengeId}`, done.userToken),
        (answer: any) => ['COMPLETE', 'FAILED', 'EXPIRED'].includes(answer?.challenge?.status), 'creating the wallets');
      if (challenge.status !== 'COMPLETE') throw broken(`Circle's wallet creation ended ${challenge.status}`);
    }
  }
  // Just after a first login the wallet may not be listed yet, so that lookup alone is asked again for a few seconds.
  const valid = (wallet: any) => typeof wallet?.id === 'string' && /^0x[0-9a-fA-F]{40}$/.test(String(wallet.address));
  let wallet: any;
  for (let i = 0; i < (pending.firstLogin ? 10 : 1) && !valid(wallet); i++) {
    if (i) await sleep(1000);
    const { wallets } = await plain(f, pending, 'GET', `/v1/w3s/wallets?pageSize=50&blockchain=${blockchain}`, done.userToken);
    wallet = Array.isArray(wallets) ? wallets[0] : undefined;
  }
  if (!valid(wallet)) throw broken(`No ${blockchain} agent wallet on this account`);
  return { ...session, walletId: wallet.id, address: wallet.address };
}

// Circle's PIN for an email user: sha256 of the user secret's first part and the challenge's share, never typed.
// Each hash goes to Circle under a one-time AES key, itself wrapped to the challenge's RSA key; the legacy pair is sent too, as the CLI does.
function approval(session: Session, challenge: { publicKey?: unknown; pinCodeUserShare?: unknown }) {
  if (typeof challenge.publicKey !== 'string') throw broken('Circle sent a challenge with no key');
  const key = forge.pki.publicKeyFromAsn1(forge.asn1.fromDer(atob(challenge.publicKey.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')))) as forge.pki.rsa.PublicKey;
  const wrap = (pinhash: string) => {
    const otkey = random(32);
    const wrapped = key.encrypt(binary(otkey), 'RSA-OAEP', { ...oaep(), seed: binary(random(32)) } as never);
    return b64(bytes(JSON.stringify({ pinhash_struct: sealJson(b64(otkey), { pinhash }), otkey: btoa(wrapped) })));
  };
  const secret = utf8(open(session.storageKey, session.encryptedUserSecret));
  const pin = b64(sha256(latin1(`${secret.split(':')[0]}${typeof challenge.pinCodeUserShare === 'string' ? challenge.pinCodeUserShare : ''}`)));
  const pinhash = sha256(bytes(pin));
  const legacy = bytes(hex(pinhash));
  return { idempotencyKey: uuid(), pinhash: wrap(b64(pinhash)), hashPinhash: b64(sha256(pinhash)),
    additionalPinhash: { version: 0, pinhash: wrap(b64(legacy)), hashPinhash: b64(bytes(hex(sha256(legacy)))) }, deviceInfo: DEVICE, pinType: 'AUTO' };
}
// Fetch a challenge and approve it; Circle's decrypted answer, or null when it sends none (a transaction's approval).
async function approve(f: Fetch, session: Session, challengeId: string): Promise<any> {
  const challenge = openJson(session.encryptionKey, await sdk(f, session, session.userToken, 'GET', `/v1/w3s/sdk/user/challenges/${challengeId}`));
  const answer = await sdkCall(f, session, session.userToken, 'POST', `/v1/w3s/sdk/user/challenges/${challengeId}/approve`,
    sealJson(session.encryptionKey, approval(session, challenge)));
  return answer === undefined ? null : openJson(session.encryptionKey, answer);
}

// Asks Circle every second, for a minute at most, until `done` says yes; Arc is final in about two seconds.
// A failed check (a dropped connection, a 5xx) is not an answer, so it is asked again; only a 4xx ends the wait early. Running out
// of time is `outcome_unknown`, never a failure: whatever was asked for may still happen.
const refused = (error: unknown) => error instanceof AgentWalletError && error.status !== undefined && error.status >= 400 && error.status < 500;
const unknown = (what: string) => new AgentWalletError('outcome_unknown', `Circle has not said how ${what} ended: look it up before sending anything again`);
// After an approval even a 4xx ends nothing (`sent`): the transaction is on its way whatever one status check answers.
async function poll<T>(ask: () => Promise<T>, done: (answer: T) => boolean, what: string, sent = false): Promise<T> {
  for (let i = 0; i < 60; i++) {
    try {
      const answer = await ask();
      if (done(answer)) return answer;
    } catch (error) { if (!sent && refused(error)) throw error; }
    await sleep(1000);
  }
  throw unknown(what);
}
const status = (id: string, transaction: any): TransactionStatus => ({ id, state: String(transaction?.state),
  hash: /^0x[0-9a-fA-F]{64}$/.test(String(transaction?.txHash)) ? transaction.txHash : null,
  errorReason: typeof transaction?.errorReason === 'string' ? transaction.errorReason : null });

// Circle refuses over-limit spending when the signature or the transaction is asked for, before any challenge exists: seen on
// Base mainnet as a 400 "spend limit exceeded" (for signing; assumed the same for transactions).
// An address the owner's lists rule out is refused the same way: seen as a 400 "Contract address is not on the allowlist."
const limited = <T>(asked: Promise<T>): Promise<T> => asked.catch(error => {
  const refusal = !(error instanceof AgentWalletError) || error.status !== 400 ? null : /spend limit/i.test(error.message) ? 'limit_exceeded' : /allowlist|blocklist/i.test(error.message) ? 'not_allowed' : null;
  throw refusal ? new AgentWalletError(refusal, error.message, 400) : error;
});

// Paid x402 resources listed in Circle's Agent Marketplace. Public: no session, no token. Check a result against your own terms
// before paying it; being listed says nothing about the seller.
export async function searchServices(filter: { query?: string; category?: string; limit?: number; offset?: number } = {}, f: Fetch = (input, init) => fetch(input, init)): Promise<Service[]> {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(filter)) if (value !== undefined) query.set(name, String(value));
  query.set('siwx', 'false');
  const response = await f(`https://api.circle.com/v2/x402/discovery/resources?${query}`);
  if (!response.ok) throw new AgentWalletError('http', `Circle's marketplace answered ${response.status}`, response.status);
  const { items } = await response.json().catch(() => ({})) as { items?: unknown };
  if (!Array.isArray(items)) throw broken("Circle's marketplace sent no list");
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  return items.filter(item => typeof item?.resource === 'string').map(item => ({ url: item.resource, method: text(item.metadata?.method), description: text(item.metadata?.description),
    provider: text(item.metadata?.provider?.name), accepts: (Array.isArray(item.accepts) ? item.accepts : []).map((a: any) => ({ amount: String(a?.amount), network: String(a?.network) })) }));
}

export type AgentWallet = ReturnType<typeof createAgentWallet>;

// One agent wallet on one network. `fetch` defaults to the runtime's, which sends its own User-Agent: this client never claims to
// be Circle's CLI. `storage` defaults to memory, so nothing is written anywhere unless the app chooses where.
export function createAgentWallet(options: { network: Network; fetch?: Fetch; storage?: Storage }) {
  const { network } = options;
  if (!(network in NETWORKS)) throw new AgentWalletError('invalid_input', `Unknown network: ${String(network)}`);
  const f: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const storage = options.storage ?? memoryStorage();
  const key = `circle-agent-wallet.${network}`;
  let keys: Promise<LoginKeys> | null = null;
  let pending: PendingLogin | null = null;
  // The owner's login for changing limits: its token is never stored, and is dropped after ten minutes or at logout.
  let ownerPending: PendingLogin | null = null;
  let owner: { token: string; until: number } | null = null;
  // Logins overlap in a real app (a second tap, a logout mid-login). Each start, logout and forget moves `attempt` on, and work
  // begun under an older one is thrown away instead of being stored.
  let attempt = 0;
  let finishing: Promise<WalletInfo> | null = null;
  const replaced = () => new AgentWalletError('invalid_input', 'This login was replaced or cancelled: start again');
  let ownerAttempt = 0;
  const drop = () => { attempt++; ownerAttempt++; finishing = null; pending = null; ownerPending = null; owner = null; };

  // The stored session, expired or not; null when there is none for this network.
  async function session(): Promise<Session | null> {
    const text = await storage.get(key);
    if (text === null) return null;
    let found: Session;
    try { found = JSON.parse(text); } catch { throw broken('The stored session is unreadable: call forget(), then log in again'); }
    return found?.network === network ? found : null;
  }
  async function live(): Promise<Session> {
    const found = await session();
    if (!found) throw new AgentWalletError('not_logged_in', 'Not logged in');
    if (isExpired(found)) throw new AgentWalletError('session_expired', 'The session expired: log in again');
    return found;
  }
  const info = (s: Session): WalletInfo => ({ network, id: s.walletId, address: s.address, blockchain: NETWORKS[network].blockchain, expiresAt: s.expiresAt });

  // EIP-712 only. The wallet is a smart contract account: verify its signatures through ERC-1271, not ecrecover, and deploy it
  // (any first transaction) before a seller's facilitator has to accept one.
  async function signTypedData({ domain, types, primaryType, message }: TypedData): Promise<Hex> {
    const s = await live();
    if (!primaryType) throw new AgentWalletError('invalid_input', 'Circle signs only typed data that names its primary type');
    const data = JSON.stringify({ types: { EIP712Domain: getTypesForEIP712Domain({ domain: domain as never }), ...types }, primaryType, domain, message },
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
    const { challengeId } = await limited(plain(f, s, 'POST', '/v1/w3s/user/sign/typedData', s.userToken, { walletId: s.walletId, data }));
    if (typeof challengeId !== 'string') throw broken('Circle sent no signing challenge');
    const signature = (await approve(f, s, challengeId))?.data?.signature;
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) throw broken('Circle approved but sent no signature');
    return signature as Hex;
  }
  // A transaction Circle has opened a challenge for: approve it, then wait for the approval and for the transaction itself.
  // Approves a challenge that sends or changes a transaction, and waits for Circle to finish with it. From the approval on,
  // Circle may act whatever this client sees, so nothing here reads as a failure unless Circle says the challenge failed:
  // an approval lost on the way is `outcome_unknown`, and one Circle says it already has (a retry) just carries on.
  async function approved(s: Session, challengeId: string, namesTransaction: boolean): Promise<any> {
    const look = () => plain(f, s, 'GET', `/v1/w3s/user/challenges/${challengeId}`, s.userToken);
    await approve(f, s, challengeId).catch(async error => {
      if (!refused(error)) throw unknown(`approval ${challengeId}`);
      const seen = await look().catch(() => null);
      if (seen?.challenge?.status !== 'COMPLETE') throw error;
    });
    // A completed approval names its transaction a moment later, so COMPLETE without one is not the end yet.
    const { challenge } = await poll(look, (answer: any) => ['FAILED', 'EXPIRED'].includes(answer?.challenge?.status)
      || (answer?.challenge?.status === 'COMPLETE' && (!namesTransaction || typeof answer.challenge.correlationIds?.[0] === 'string')), `approval ${challengeId}`, true);
    if (challenge.status !== 'COMPLETE') throw new AgentWalletError('transaction_failed', `Circle's approval ended ${challenge.status}`);
    return challenge;
  }
  async function settle(s: Session, challengeId: unknown): Promise<{ hash: Hex; transactionId: string }> {
    if (typeof challengeId !== 'string') throw broken('Circle sent no transaction challenge');
    const id = (await approved(s, challengeId, true)).correlationIds[0];
    const { transaction } = await poll(() => plain(f, s, 'GET', `/v1/w3s/transactions/${id}`, s.userToken),
      (answer: any) => ['CONFIRMED', 'COMPLETE', 'FAILED', 'CANCELLED', 'DENIED'].includes(answer?.transaction?.state), `transaction ${id}`, true);
    const { state, hash, errorReason } = status(id, transaction);
    if (state !== 'CONFIRMED' && state !== 'COMPLETE') throw new AgentWalletError('transaction_failed', `Circle transaction ${id} ${state}${errorReason ? `: ${errorReason}` : ''}`);
    if (!hash) throw broken(`Circle confirmed transaction ${id} but sent no hash`);
    return { hash, transactionId: id };
  }
  // The caller's own key makes a retry safe: Circle treats two requests with one key as the same request.
  const idempotency = (key?: string) => {
    if (key !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) throw new AgentWalletError('invalid_input', 'The idempotency key is a UUID');
    return key ?? uuid();
  };
  // One contract call from the wallet, as a Circle transaction: Circle's bundler sends it (and sponsored the gas where we measured),
  // and the hash comes back only once Circle reports the transaction confirmed. On `outcome_unknown`, retry with the same
  // `idempotencyKey` or look the challenge up: a fresh call could send it twice.
  async function call(tx: { to: string; data: string; idempotencyKey?: string }): Promise<{ hash: Hex; transactionId: string }> {
    const s = await live();
    const { challengeId } = await limited(plain(f, s, 'POST', '/v1/w3s/user/transactions/contractExecution', s.userToken, { idempotencyKey: idempotency(tx.idempotencyKey),
      walletId: s.walletId, sourceAddress: s.address, blockchain: NETWORKS[network].blockchain, contractAddress: tx.to, callData: tx.data, feeLevel: 'MEDIUM' }));
    return settle(s, challengeId);
  }
  // A plain message (EIP-191), as text or as raw bytes. Like every signature from this wallet it verifies through ERC-1271.
  async function signMessage(message: string | { raw: Hex | Uint8Array }): Promise<Hex> {
    const s = await live();
    const raw = typeof message === 'string' ? null : typeof message.raw === 'string' ? message.raw : `0x${hex(message.raw).toLowerCase()}`;
    if (raw !== null && !/^0x([0-9a-fA-F]{2})*$/.test(raw)) throw new AgentWalletError('invalid_input', 'Raw message bytes are 0x-prefixed hex');
    const { challengeId } = await limited(plain(f, s, 'POST', '/v1/w3s/user/sign/message', s.userToken,
      raw === null ? { walletId: s.walletId, message } : { walletId: s.walletId, message: raw, encodedByHex: true }));
    if (typeof challengeId !== 'string') throw broken('Circle sent no signing challenge');
    const signature = (await approve(f, s, challengeId))?.data?.signature;
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) throw broken('Circle approved but sent no signature');
    return signature as Hex;
  }
  // Cancelling or speeding up a transaction is itself a challenge, approved like a signature.
  async function change(id: string, how: 'cancel' | 'accelerate'): Promise<TransactionStatus> {
    const s = await live();
    const { challengeId } = await plain(f, s, 'POST', `/v1/w3s/user/transactions/${encodeURIComponent(id)}/${how}`, s.userToken, { idempotencyKey: uuid() });
    if (typeof challengeId !== 'string') throw broken('Circle sent no challenge');
    await approved(s, challengeId, false);
    const { transaction } = await poll(() => plain(f, s, 'GET', `/v1/w3s/transactions/${encodeURIComponent(id)}`, s.userToken), () => true, `transaction ${id}`, true);
    return status(id, transaction);
  }
  const unsupported = async (): Promise<never> => { throw new AgentWalletError('invalid_input', 'This account signs messages and typed data; send transactions with call()'); };

  return {
    network,
    login: {
      // Start making the RSA key ahead of time, for instance when the email field takes focus: it takes seconds on a phone.
      async prepare(): Promise<void> { await (keys ??= loginKeys()); },
      // Circle emails the code. `codePrefix` is the letters before the dash in "ABC-123456", so the user may type the digits alone.
      async start(email: string): Promise<{ codePrefix: string | null }> {
        const mine = ++attempt;
        pending = null; finishing = null;
        const made = keys ?? loginKeys(); keys = null; // a fresh key for each attempt, as the CLI does
        const started = await startLogin(f, network, email.trim(), await made);
        if (mine !== attempt) throw replaced();
        pending = started;
        return { codePrefix: started.otpHead ?? null };
      },
      // Stores the session. After a wrong code the login stays open, so finish can be called again; so can it after a failure
      // later on, which picks up from the accepted code. Two calls at once share one answer.
      finish(code: string): Promise<WalletInfo> {
        if (finishing) return finishing;
        const running: Promise<WalletInfo> = (async () => {
          const current = pending, mine = attempt;
          if (!current) throw new AgentWalletError('invalid_input', 'No login in progress: call login.start first');
          const s = await finishLogin(f, current, code).catch(error => {
            // The accepted code's token has gone stale: nothing left to resume, so the next finish says to start again.
            if (current.accepted && error instanceof AgentWalletError && error.status === 401 && pending === current) pending = null;
            throw error;
          });
          if (mine !== attempt) throw replaced();
          await storage.set(key, JSON.stringify(s));
          pending = null;
          return info(s);
        })().finally(() => { if (finishing === running) finishing = null; });
        return finishing = running;
      },
    },
    session,
    // From the session, no network call. The address is the same until the next login.
    async wallet(): Promise<WalletInfo> { return info(await live()); },
    // The account's wallets on every chain of this environment: a first login makes one per chain, and this client uses one of them.
    async wallets(): Promise<{ id: string; address: string; blockchain: string }[]> {
      const s = await live();
      const { wallets } = await plain(f, s, 'GET', '/v1/w3s/wallets?pageSize=50', s.userToken);
      if (!Array.isArray(wallets)) throw broken('Circle sent no wallets');
      return wallets.filter((w: any) => typeof w?.id === 'string' && typeof w?.address === 'string').map((w: any) => ({ id: w.id, address: w.address, blockchain: String(w.blockchain) }));
    },
    // This wallet's latest transactions at Circle, newest first as Circle lists them: contract calls and transfers, not x402
    // payments, which the seller's facilitator sends. A contract call that moves a token is listed twice, once as each operation.
    async transactions(limit = 20): Promise<(TransactionStatus & { operation: string | null })[]> {
      const s = await live();
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AgentWalletError('invalid_input', 'The limit is a whole number from 1 to 50');
      const { transactions } = await plain(f, s, 'GET', `/v1/w3s/transactions?walletIds=${s.walletId}&pageSize=${limit}`, s.userToken);
      if (!Array.isArray(transactions)) throw broken('Circle sent no transactions');
      return transactions.filter((t: any) => typeof t?.id === 'string').map((t: any) => ({ ...status(t.id, t), operation: typeof t.operation === 'string' ? t.operation : null }));
    },
    // Every token Circle reports for the wallet, amounts as decimal strings in whole tokens. A chain's own gas token has no
    // contract, so its address is empty; on Arc that is USDC, which Circle lists a second time as the ERC-20.
    async balances(): Promise<{ symbol: string; address: string; amount: string }[]> {
      const s = await live();
      const { tokenBalances } = await plain(f, s, 'GET', `/v1/w3s/wallets/${s.walletId}/balances`, s.userToken);
      if (!Array.isArray(tokenBalances)) return [];
      return tokenBalances.filter((b: any) => typeof b?.amount === 'string' && typeof b?.token?.symbol === 'string')
        .map((b: any) => ({ symbol: b.token.symbol, address: String(b.token.tokenAddress ?? '').toLowerCase(), amount: b.amount }));
    },
    // USDC on this network as Circle reports it, a decimal string ("19.99"); "0" when the wallet has none.
    async balance(): Promise<string> {
      const s = await live();
      const { tokenBalances } = await plain(f, s, 'GET', `/v1/w3s/wallets/${s.walletId}/balances`, s.userToken);
      const usdc = Array.isArray(tokenBalances) ? tokenBalances.find((b: any) => String(b?.token?.tokenAddress).toLowerCase() === NETWORKS[network].usdc) : undefined;
      return typeof usdc?.amount === 'string' ? usdc.amount : '0';
    },
    signTypedData,
    signMessage,
    // A viem account (type 'local') for anything that takes one. signMessage and signTransaction throw.
    async account(): Promise<LocalAccount> {
      const { address } = await live();
      return toAccount({ address, signMessage: ({ message }) => signMessage(message as string | { raw: Hex | Uint8Array }), signTransaction: unsupported, signTypedData: data => signTypedData(data as unknown as TypedData) });
    },
    // For @x402/evm: registerExactEvmScheme(client, { signer: await wallet.x402Signer() }). Run your own checks on the 402 first.
    async x402Signer(): Promise<X402Signer> { return { address: (await live()).address, signTypedData }; },
    call,
    // A new wallet is a smart contract account that does not exist on-chain yet, and Circle will not sign for it until it does:
    // its first transaction deploys it. This sends one that moves nothing, a zero USDC approve to the wallet itself, with the gas
    // sponsored where we measured. Harmless to repeat on a wallet that is already deployed.
    async deploy(): Promise<{ hash: Hex; transactionId: string }> {
      const { address } = await live();
      return call({ to: NETWORKS[network].usdc, data: `0x095ea7b3${address.slice(2).toLowerCase().padStart(64, '0')}${'0'.repeat(64)}` });
    },
    // Sends a token from the wallet, USDC unless `token` names another contract. `amount` is a decimal string in whole tokens ("0.01").
    async transfer(tx: { to: string; amount: string; token?: string; idempotencyKey?: string }): Promise<{ hash: Hex; transactionId: string }> {
      const s = await live();
      const address = /^0x[0-9a-fA-F]{40}$/;
      if (!address.test(tx.to) || (tx.token !== undefined && !address.test(tx.token))) throw new AgentWalletError('invalid_input', 'Not an address');
      if (!/^\d+(\.\d+)?$/.test(tx.amount) || Number(tx.amount) <= 0) throw new AgentWalletError('invalid_input', 'The amount is a positive decimal, like "0.01"');
      const { challengeId } = await limited(plain(f, s, 'POST', '/v1/w3s/user/transactions/transfer', s.userToken, { idempotencyKey: idempotency(tx.idempotencyKey), walletId: s.walletId,
        sourceAddress: s.address, destinationAddress: tx.to, amounts: [tx.amount], blockchain: NETWORKS[network].blockchain, tokenAddress: tx.token ?? NETWORKS[network].usdc, feeLevel: 'MEDIUM' }));
      return settle(s, challengeId);
    },
    // Asks Circle's testnet faucet to send the wallet some of a token. Circle sends it a little later: watch balance().
    async fund(token: 'usdc' | 'eth' | 'eurc' | 'native' = 'usdc'): Promise<void> {
      const s = await live();
      if (network !== 'arc') throw new AgentWalletError('invalid_input', 'Circle has a faucet on testnet only');
      await plain(f, s, 'POST', '/fund', s.userToken, { address: s.address, blockchain: NETWORKS[network].blockchain, token });
    },
    // For a transaction Circle has not finished: stop it, or resend it with a higher fee. Each answers where it then stands.
    cancel: (id: string) => change(id, 'cancel'),
    accelerate: (id: string) => change(id, 'accelerate'),
    // Where a transaction stands at Circle, for one that call() gave up waiting on (its id is in that error's message).
    async transaction(id: string): Promise<TransactionStatus> {
      const s = await live();
      return status(id, (await plain(f, s, 'GET', `/v1/w3s/transactions/${encodeURIComponent(id)}`, s.userToken)).transaction);
    },
    // Circle's spending limits on this wallet. They exist on mainnet only, and Circle enforces them before it signs or sends anything.
    // Reading takes the agent's session. Changing takes the wallet owner's own login, a second emailed code: the agent cannot raise
    // its own limits.
    limits: (() => {
      const policy: Target = { network, base: ROOT };
      const mainnet = () => { if (network !== 'base') throw new AgentWalletError('invalid_input', "Circle's limits exist on mainnet only"); };
      const cap = (value: unknown) => (typeof value === 'string' && value ? value : null);
      const ownerToken = () => {
        if (!owner || Date.now() >= owner.until) { owner = null; throw new AgentWalletError('not_logged_in', 'Changing limits needs the owner login: limits.owner.start, then limits.owner.finish'); }
        return owner.token;
      };
      const write = (s: Session, policy_type: string, rule_type: string, params: object) =>
        plain(f, policy, 'POST', '/v1/policy', ownerToken(), { wallet_id: s.walletId, blockchain: NETWORKS[network].blockchain, policy_type, rule_type, params }).catch(error => {
          throw error instanceof AgentWalletError && error.status === 409 ? new AgentWalletError('invalid_input', 'A custom rule of this kind is already set: call limits.reset() first', 409) : error;
        });
      async function read(): Promise<Limit[]> {
        mainnet(); const s = await live();
        const { policies } = await plain(f, policy, 'GET', `/v1/policy/limit?${new URLSearchParams({ wallet_id: s.walletId, wallet_address: s.address, blockchain: NETWORKS[network].blockchain })}`, s.userToken);
        if (!Array.isArray(policies)) throw broken('Circle sent no limits');
        return policies.map((row: any) => ({ policyType: String(row?.policy_type), ruleType: String(row?.rule_type), blockchain: cap(row?.blockchain), perTx: cap(row?.per_tx_limit),
          daily: cap(row?.daily_limit), weekly: cap(row?.weekly_limit), monthly: cap(row?.monthly_limit), addresses: Array.isArray(row?.addresses) ? row.addresses : [],
          origin: String(row?.origin), id: cap(row?.policy_id) }));
      }
      return {
        read,
        // What is left to spend in each window, by rule type.
        async budget(): Promise<Budget[]> {
          mainnet(); const s = await live();
          const { policies } = await plain(f, policy, 'GET', `/v1/policy/budget?wallet_address=${s.address.toLowerCase()}`, s.userToken);
          if (!policies || typeof policies !== 'object') throw broken('Circle sent no budget');
          return Object.entries(policies).map(([policyType, row]: [string, any]) => ({ policyType, perTx: cap(row?.per_tx_limit), daily: cap(row?.daily_limit), dailyRemaining: cap(row?.daily_remaining),
            weekly: cap(row?.weekly_limit), weeklyRemaining: cap(row?.weekly_remaining), monthly: cap(row?.monthly_limit), monthlyRemaining: cap(row?.monthly_remaining), origin: String(row?.origin) }));
        },
        owner: {
          // Circle emails a second code, to the same address as the agent's login.
          async start(email: string): Promise<{ codePrefix: string | null }> {
            mainnet(); await live();
            const mine = ++ownerAttempt;
            ownerPending = null; owner = null;
            const started = await startLogin(f, network, email.trim(), await loginKeys(), OWNER_PROXY);
            if (mine !== ownerAttempt) throw replaced();
            ownerPending = started;
            return { codePrefix: started.otpHead ?? null };
          },
          async finish(code: string): Promise<void> {
            const current = ownerPending, mine = ownerAttempt;
            if (!current) throw new AgentWalletError('invalid_input', 'No owner login in progress: call limits.owner.start first');
            const { userToken } = await submitCode(f, current, code);
            if (mine !== ownerAttempt) throw replaced();
            const exp = jwtPayload(userToken)?.exp; // never longer than Circle's own expiry for the token
            owner = { token: userToken, until: Math.min(Date.now() + 10 * 60_000, typeof exp === 'number' ? exp * 1000 : Infinity) };
            ownerPending = null;
          },
          // Drops the owner's token now, without waiting out the ten minutes: call it as soon as the rules are set.
          end(): void { ownerAttempt++; owner = null; ownerPending = null; },
        },
        // A cap per payment, day, week and month on stablecoin transfers from this wallet on this chain, each at least the one
        // before. It does not replace a custom limit: Circle refuses, and so does this, until reset() has removed the old one.
        // (The CLI also offers this cap for contract calls; Circle answered that request with a bare 400, so it is not offered here.)
        async set(limit: { perTx: string; daily: string; weekly: string; monthly: string }): Promise<void> {
          mainnet(); const s = await live();
          const amounts = [limit.perTx, limit.daily, limit.weekly, limit.monthly];
          if (amounts.some(amount => typeof amount !== 'string' || !/^\d+(\.\d+)?$/.test(amount)) || amounts.some((amount, i) => i > 0 && Number(amount) < Number(amounts[i - 1])))
            throw new AgentWalletError('invalid_input', 'Limits are decimals with perTx ≤ daily ≤ weekly ≤ monthly');
          await write(s, 'STABLECOIN_TRANSFER', 'TRANSFER_LIMIT', { per_tx: limit.perTx, daily: limit.daily, weekly: limit.weekly, monthly: limit.monthly });
        },
        // The only contracts the wallet may call or addresses it may pay (an allowlist), or ones it never may (a blocklist). A
        // contract list governs contract calls and a recipient list stablecoin transfers. One list of each kind at a time:
        // reset(id) the old one first.
        async setList(rule: 'contract-allowlist' | 'contract-blocklist' | 'recipient-allowlist' | 'recipient-blocklist', addresses: string[]): Promise<void> {
          mainnet(); const s = await live();
          if (!Array.isArray(addresses) || !addresses.length || addresses.some(address => !/^0x[0-9a-fA-F]{40}$/.test(String(address))))
            throw new AgentWalletError('invalid_input', 'The list is one or more 0x addresses');
          await write(s, rule.startsWith('contract') ? 'CONTRACT_INTERACTION' : 'STABLECOIN_TRANSFER', rule.toUpperCase().replace('-', '_'),
            { addresses: [...new Set(addresses.map(address => address.toLowerCase()))] });
        },
        // Removes the owner's custom rules on this chain, or the one with this id (from read()). With none left, Circle's default applies.
        async reset(id?: string): Promise<void> {
          mainnet(); await live();
          const token = ownerToken();
          const rows = (await read()).filter(row => row.origin === 'CUSTOM' && row.id && row.blockchain === NETWORKS[network].blockchain && (id === undefined || row.id === id));
          if (id !== undefined && !rows.length) throw new AgentWalletError('invalid_input', `No custom rule ${id} on this chain`);
          for (const row of rows) {
            await plain(f, policy, 'DELETE', `/v1/policy/${encodeURIComponent(row.id!)}`, token)
              .catch(error => { if (!(error instanceof AgentWalletError && error.status === 404)) throw error; }); // 404: already gone
          }
        },
      };
    })(),
    // Revokes the session at Circle ('local': this session; 'all': every device's, for a lost phone), then removes it from storage.
    // If Circle does not confirm, this throws and the session stays, so it can be retried; a session Circle already refuses (401,
    // or the 403 it answered a revoked session on Arc testnet) or one past its expiry is just removed.
    async logout(scope: 'local' | 'all' = 'local'): Promise<void> {
      drop();
      const s = await session();
      if (s && !isExpired(s)) {
        try { await plain(f, s, 'POST', '/v1/w3s/users/token/deactivate', s.userToken, { idempotencyKey: uuid(), scope }); }
        catch (error) { if (!(error instanceof AgentWalletError && (error.status === 401 || error.status === 403))) throw error; }
      }
      await storage.remove(key);
    },
    // Removes the stored session without telling Circle: it stays valid there until it expires.
    async forget(): Promise<void> { drop(); await storage.remove(key); },
  };
}
