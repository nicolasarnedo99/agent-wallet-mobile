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
  arc: { proxy: 'https://agentic-wallet.circle.com/proxy/test', blockchain: 'ARC-TESTNET', chainId: 5042002, usdc: '0x3600000000000000000000000000000000000000', cliLogin: 'circle wallet login --testnet' },
  base: { proxy: 'https://agentic-wallet.circle.com/proxy/live', blockchain: 'BASE', chainId: 8453, usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', cliLogin: 'circle wallet login' },
} as const;
// The chains a first testnet login creates wallets on: the CLI's own list (chain-map.ts).
const TESTNET_CHAINS = ['ETH-SEPOLIA', 'MATIC-AMOY', 'ARB-SEPOLIA', 'AVAX-FUJI', 'OP-SEPOLIA', 'BASE-SEPOLIA', 'UNI-SEPOLIA', 'MONAD-TESTNET', 'ARC-TESTNET'];
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
export type Storage = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> };

export type ErrorCode = 'not_logged_in' | 'session_expired' | 'needs_cli_bootstrap' | 'wrong_code' | 'invalid_input' | 'http' | 'protocol' | 'transaction_failed' | 'limit_exceeded';
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
type Target = { network: Network; quiet?: boolean };
type Who = Target & { appId: string; deviceId: string };

// Only the status, Circle's numeric code and (outside a login) its short message are kept: a body could echo credentials.
async function request(f: Fetch, on: Target, method: 'GET' | 'POST', path: string, headers: Record<string, string>, body?: string): Promise<any> {
  const response = await f(`${NETWORKS[on.network].proxy}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body }) });
  const text = await response.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  if (!response.ok) throw new AgentWalletError('http', `Circle ${method} ${path.split('?')[0]} answered ${response.status}${typeof json?.code === 'number' ? ` (code ${json.code})` : ''}${
    !on.quiet && typeof json?.message === 'string' ? `: ${json.message.slice(0, 120)}` : ''}`, response.status);
  return json ?? {};
}
async function plain(f: Fetch, on: Target, method: 'GET' | 'POST', path: string, token?: string, body?: unknown, headers: Record<string, string> = {}): Promise<any> {
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
  otpToken: string; otpHead?: string; firstLogin: boolean };

// Circle emails the code. Throws, before the code is asked for, at an account the Circle CLI has not set up yet.
async function startLogin(f: Fetch, network: Network, email: string, keys: LoginKeys): Promise<PendingLogin> {
  const on: Target = { network, quiet: true };
  const deviceId = uuid();
  const device = await plain(f, on, 'POST', '/v1/w3s/auth/deviceToken', undefined, { idempotencyKey: uuid(), deviceId });
  if (typeof device.deviceToken !== 'string' || typeof device.deviceEncryptionKey !== 'string') throw broken('Circle sent no device credentials');
  const challenge = await plain(f, on, 'POST', '/v1/w3s/auth/challenges', device.deviceToken, { idempotencyKey: uuid(), operation: 'login',
    registeredFactors: [{ factor: 'email_otp', emailOtp: { destination: email, suite: 'RSA_OAEP_256_A256GCM', publicKey: keys.publicKey } }] });
  // A first login also creates the wallets. On mainnet that is still left to the CLI: nothing here has created mainnet wallets.
  const firstLogin = challenge.operation === 'bootstrap';
  if (firstLogin && network !== 'arc') throw new AgentWalletError('needs_cli_bootstrap',
    `No agent wallets on this account yet: log in once with the Circle CLI (${NETWORKS[network].cliLogin}), then here`);
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

// The code goes into one encrypted request and nowhere else.
async function finishLogin(f: Fetch, pending: PendingLogin, typed: string): Promise<Session> {
  const code = fullCode(typed, pending.otpHead);
  let done: any;
  try {
    done = openJson(pending.deviceEncryptionKey, await sdk(f, pending, pending.deviceToken, 'POST', `/v1/w3s/sdk/auth/challenges/${pending.challengeId}/factors`,
      sealJson(pending.deviceEncryptionKey, { idempotencyKey: uuid(), factorSubmissions: [{ requiredFactorIndex: pending.factorIndex,
        emailOtpProof: { destination: pending.email, otpToken: pending.otpToken, code } }] })));
  } catch (error) {
    if (error instanceof AgentWalletError && (error.status === 400 || error.status === 401)) throw new AgentWalletError('wrong_code', 'Wrong or expired code: ask for a new one', error.status);
    throw error;
  }
  if (String(done.state).toLowerCase() !== 'completed' || ['userToken', 'encryptionKey', 'userSecret', 'storageKey'].some(field => typeof done[field] !== 'string' || !done[field]))
    throw broken('Circle did not complete the login');
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
  const exp = jwtPayload(done.userToken)?.exp;
  if (typeof exp !== 'number') throw broken('Circle sent a session with no expiry');
  const { blockchain } = NETWORKS[pending.network];
  const session = { network: pending.network, deviceId: pending.deviceId, appId: pending.appId, userToken: done.userToken, encryptionKey: done.encryptionKey,
    encryptedUserSecret: seal(done.storageKey, bytes(done.userSecret)), storageKey: done.storageKey, expiresAt: exp * 1000 };
  // A first login: Circle creates a wallet on each chain, behind a challenge approved like a signature. Unlike the CLI, a creation
  // that fails or never finishes is an error here, so no session is kept for an account that has no wallet.
  if (pending.firstLogin) {
    const created = await plain(f, pending, 'POST', '/v1/w3s/user/initialize', done.userToken, { idempotencyKey: uuid(), accountType: 'SCA', blockchains: TESTNET_CHAINS })
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
async function poll<T>(ask: () => Promise<T>, done: (answer: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 60; i++) {
    const answer = await ask();
    if (done(answer)) return answer;
    await sleep(1000);
  }
  throw broken(`Circle had not finished ${what} after a minute`);
}
const status = (id: string, transaction: any): TransactionStatus => ({ id, state: String(transaction?.state),
  hash: /^0x[0-9a-fA-F]{64}$/.test(String(transaction?.txHash)) ? transaction.txHash : null,
  errorReason: typeof transaction?.errorReason === 'string' ? transaction.errorReason : null });

// Circle refuses over-limit spending when the signature or the transaction is asked for, before any challenge exists: seen on
// Base mainnet as a 400 "spend limit exceeded" (for signing; assumed the same for transactions).
const limited = <T>(asked: Promise<T>): Promise<T> => asked.catch(error => {
  throw error instanceof AgentWalletError && error.status === 400 && /spend limit/i.test(error.message) ? new AgentWalletError('limit_exceeded', error.message, 400) : error;
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
  async function settle(s: Session, challengeId: unknown): Promise<{ hash: Hex; transactionId: string }> {
    if (typeof challengeId !== 'string') throw broken('Circle sent no transaction challenge');
    await approve(f, s, challengeId);
    const { challenge } = await poll(() => plain(f, s, 'GET', `/v1/w3s/user/challenges/${challengeId}`, s.userToken),
      (answer: any) => ['COMPLETE', 'FAILED', 'EXPIRED'].includes(answer?.challenge?.status), `approval ${challengeId}`);
    const id = challenge.correlationIds?.[0];
    if (challenge.status !== 'COMPLETE' || typeof id !== 'string') throw new AgentWalletError('transaction_failed', `Circle's approval ended ${challenge.status}`);
    const { transaction } = await poll(() => plain(f, s, 'GET', `/v1/w3s/transactions/${id}`, s.userToken),
      (answer: any) => ['CONFIRMED', 'COMPLETE', 'FAILED', 'CANCELLED', 'DENIED'].includes(answer?.transaction?.state), `transaction ${id}`);
    const { state, hash, errorReason } = status(id, transaction);
    if (state !== 'CONFIRMED' && state !== 'COMPLETE') throw new AgentWalletError('transaction_failed', `Circle transaction ${id} ${state}${errorReason ? `: ${errorReason}` : ''}`);
    if (!hash) throw broken(`Circle confirmed transaction ${id} but sent no hash`);
    return { hash, transactionId: id };
  }
  const unsupported = async (): Promise<never> => { throw new AgentWalletError('invalid_input', 'This account only signs EIP-712 typed data; send transactions with call()'); };

  return {
    network,
    login: {
      // Start making the RSA key ahead of time, for instance when the email field takes focus: it takes seconds on a phone.
      async prepare(): Promise<void> { await (keys ??= loginKeys()); },
      // Circle emails the code. `codePrefix` is the letters before the dash in "ABC-123456", so the user may type the digits alone.
      async start(email: string): Promise<{ codePrefix: string | null }> {
        pending = null;
        const made = keys ?? loginKeys(); keys = null; // a fresh key for each attempt, as the CLI does
        pending = await startLogin(f, network, email.trim(), await made);
        return { codePrefix: pending.otpHead ?? null };
      },
      // Stores the session. After a wrong code the login stays open, so finish can be called again.
      async finish(code: string): Promise<WalletInfo> {
        if (!pending) throw new AgentWalletError('invalid_input', 'No login in progress: call login.start first');
        const s = await finishLogin(f, pending, code);
        await storage.set(key, JSON.stringify(s));
        pending = null;
        return info(s);
      },
    },
    session,
    // From the session, no network call. The address is the same until the next login.
    async wallet(): Promise<WalletInfo> { return info(await live()); },
    // USDC on this network as Circle reports it, a decimal string ("19.99"); "0" when the wallet has none.
    async balance(): Promise<string> {
      const s = await live();
      const { tokenBalances } = await plain(f, s, 'GET', `/v1/w3s/wallets/${s.walletId}/balances`, s.userToken);
      const usdc = Array.isArray(tokenBalances) ? tokenBalances.find((b: any) => String(b?.token?.tokenAddress).toLowerCase() === NETWORKS[network].usdc) : undefined;
      return typeof usdc?.amount === 'string' ? usdc.amount : '0';
    },
    signTypedData,
    // A viem account (type 'local') for anything that takes one. signMessage and signTransaction throw.
    async account(): Promise<LocalAccount> {
      const { address } = await live();
      return toAccount({ address, signMessage: unsupported, signTransaction: unsupported, signTypedData: data => signTypedData(data as unknown as TypedData) });
    },
    // For @x402/evm: registerExactEvmScheme(client, { signer: await wallet.x402Signer() }). Run your own checks on the 402 first.
    async x402Signer(): Promise<X402Signer> { return { address: (await live()).address, signTypedData }; },
    // One contract call from the wallet, as a Circle transaction: Circle's bundler sends it (and sponsored the gas where we measured),
    // and the hash comes back only once Circle reports the transaction confirmed.
    async call(tx: { to: string; data: string }): Promise<{ hash: Hex; transactionId: string }> {
      const s = await live();
      const { challengeId } = await limited(plain(f, s, 'POST', '/v1/w3s/user/transactions/contractExecution', s.userToken, { idempotencyKey: uuid(),
        walletId: s.walletId, sourceAddress: s.address, blockchain: NETWORKS[network].blockchain, contractAddress: tx.to, callData: tx.data, feeLevel: 'MEDIUM' }));
      return settle(s, challengeId);
    },
    // Sends a token from the wallet, USDC unless `token` names another contract. `amount` is a decimal string in whole tokens ("0.01").
    async transfer(tx: { to: string; amount: string; token?: string }): Promise<{ hash: Hex; transactionId: string }> {
      const s = await live();
      const address = /^0x[0-9a-fA-F]{40}$/;
      if (!address.test(tx.to) || (tx.token !== undefined && !address.test(tx.token))) throw new AgentWalletError('invalid_input', 'Not an address');
      if (!/^\d+(\.\d+)?$/.test(tx.amount) || Number(tx.amount) <= 0) throw new AgentWalletError('invalid_input', 'The amount is a positive decimal, like "0.01"');
      const { challengeId } = await limited(plain(f, s, 'POST', '/v1/w3s/user/transactions/transfer', s.userToken, { idempotencyKey: uuid(), walletId: s.walletId,
        sourceAddress: s.address, destinationAddress: tx.to, amounts: [tx.amount], blockchain: NETWORKS[network].blockchain, tokenAddress: tx.token ?? NETWORKS[network].usdc, feeLevel: 'MEDIUM' }));
      return settle(s, challengeId);
    },
    // Asks Circle's testnet faucet to send the wallet some of a token. Circle sends it a little later: watch balance().
    async fund(token: 'usdc' | 'eth' | 'eurc' | 'native' = 'usdc'): Promise<void> {
      const s = await live();
      if (network !== 'arc') throw new AgentWalletError('invalid_input', 'Circle has a faucet on testnet only');
      await plain(f, s, 'POST', '/fund', s.userToken, { address: s.address, blockchain: NETWORKS[network].blockchain, token });
    },
    // Where a transaction stands at Circle, for one that call() gave up waiting on (its id is in that error's message).
    async transaction(id: string): Promise<TransactionStatus> {
      const s = await live();
      return status(id, (await plain(f, s, 'GET', `/v1/w3s/transactions/${encodeURIComponent(id)}`, s.userToken)).transaction);
    },
    // Revokes the session at Circle ('local': this session; 'all': every device's, for a lost phone), then removes it from storage.
    // If Circle does not confirm, this throws and the session stays, so it can be retried; a session Circle already refuses (401,
    // or the 403 it answered a revoked session on Arc testnet) or one past its expiry is just removed.
    async logout(scope: 'local' | 'all' = 'local'): Promise<void> {
      const s = await session();
      if (s && !isExpired(s)) {
        try { await plain(f, s, 'POST', '/v1/w3s/users/token/deactivate', s.userToken, { idempotencyKey: uuid(), scope }); }
        catch (error) { if (!(error instanceof AgentWalletError && (error.status === 401 || error.status === 403))) throw error; }
      }
      await storage.remove(key);
    },
    // Removes the stored session without telling Circle: it stays valid there until it expires.
    async forget(): Promise<void> { await storage.remove(key); },
  };
}
