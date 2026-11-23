// A stand-in for Circle's proxy, written with Node's own crypto from the Circle CLI 1.4.0 source, so the library's AES, RSA and PIN
// code is checked against a second implementation rather than against itself. Nothing here talks to Circle.
import { constants, createCipheriv, createDecipheriv, createHash, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import { NETWORKS, type Network } from '../src/index.js';

export const EMAIL = 'agent@example.com';
export const HEAD = 'K7Q';
export const CODE = '123456';
export const SECRET = 'u5er-secret:rest';
export const SHARE = 'pin-share';
export const SIGNATURE = `0x${'cd'.repeat(65)}`;
export const MINED = `0x${'ef'.repeat(32)}`;
export const ARC_USDC = '0x3600000000000000000000000000000000000000';
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const WALLETS = {
  arc: { id: 'w-arc', address: '0x7286ec1ec69b477bba05ce28a21b1e03748b7765', blockchain: 'ARC-TESTNET' },
  base: { id: 'w-base', address: '0xece745ef9d38a03473a5adafa6b71951170448d4', blockchain: 'BASE' },
} as const;

const challengeKeys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
// One device and one user for every fake, so a session from one login works against a fresh fake in another test.
const device = { token: 'device-token', key: randomBytes(32).toString('base64') };
const jwt = (payload: object) => `${[{ alg: 'none' }, payload].map(p => Buffer.from(JSON.stringify(p)).toString('base64url')).join('.')}.sig`;
export const user = { token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), key: randomBytes(32).toString('base64') };
const otpToken = jwt({ otpHead: HEAD });

const aes = (keyB64: string, value: unknown) => {
  const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv);
  return Buffer.concat([iv, c.update(JSON.stringify(value)), c.final(), c.getAuthTag()]).toString('base64');
};
const unaes = (keyB64: string, text: string) => {
  const data = Buffer.from(text, 'base64'); const d = createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), data.subarray(0, 12));
  d.setAuthTag(data.subarray(-16));
  return JSON.parse(Buffer.concat([d.update(data.subarray(12, -16)), d.final()]).toString());
};
const der = (tag: number, body: Buffer) =>
  Buffer.concat([Buffer.from([tag]), body.length < 128 ? Buffer.from([body.length]) : Buffer.from([0x82, body.length >> 8, body.length & 255]), body]);
// Circle's OTP-token envelope: a fresh AES key wrapped to the client's RSA key (OAEP, SHA-256), and the token sealed under it.
function envelope(publicKeyPem: string, text: string): string {
  const key = randomBytes(32); const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([iv, c.update(text), c.final(), c.getAuthTag()]);
  const wrapped = publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return der(0x30, Buffer.concat([der(0x80, Buffer.from([0])), der(0xa1, der(0x04, sealed)), der(0x82, wrapped),
    der(0x83, Buffer.from('60864801650304012e', 'hex')), der(0x84, Buffer.from('2a864886f70d01010b', 'hex'))])).toString('base64');
}
export const sha256 = (data: string | Buffer, encoding: 'utf8' | 'latin1' = 'utf8') => createHash('sha256').update(data as string, encoding).digest();

// The pinhash Circle's server would unwrap from an approval: RSA-OAEP-SHA256 opens the one-time AES key, which opens {pinhash}.
export function unwrapPinhash(encrypted: string): string {
  const { pinhash_struct, otkey } = JSON.parse(Buffer.from(encrypted, 'base64').toString());
  const key = privateDecrypt({ key: challengeKeys.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(otkey, 'base64'));
  return unaes(key.toString('base64'), pinhash_struct).pinhash;
}

export function fakeCircle(network: Network = 'arc', options: { operation?: 'login' | 'bootstrap'; transaction?: object; deactivate?: number; overLimit?: boolean } = {}) {
  const { operation = 'login', transaction = { state: 'CONFIRMED', txHash: MINED }, deactivate = 204 } = options;
  const proxy = NETWORKS[network].proxy;
  const wallet = WALLETS[network];
  const calls: string[] = [];
  const seen: { clientKey?: string; deviceId?: string; typedData?: any; approve?: any; execution?: any; polls?: number; deactivate?: any } = {};
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    expect(String(input).startsWith(`${proxy}/`)).toBe(true);
    const method = init.method ?? 'GET';
    const path = url.pathname.slice(new URL(proxy).pathname.length);
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push(`${method} ${path}`);
    expect(headers.get('user-agent')).toBeNull(); // the runtime's own User-Agent goes out: the library never claims to be the CLI
    if (path.startsWith('/v1/w3s/sdk/')) {
      expect(headers.get('x-app-id')).toBe('app-1');
      expect(headers.get('authorization')).toBe(`Bearer ${headers.get('x-user-token')}`);
      seen.deviceId ??= headers.get('x-device-id') ?? 'missing';
      expect(headers.get('x-device-id')).toBe(seen.deviceId);
    }
    const asUser = () => expect(headers.get('x-user-token')).toBe(user.token);
    // A signing challenge (sig-1) answers with the signature; a transaction challenge (tx-1) answers with no encrypted body, as Circle may.
    const challenge = /^(GET|POST) \/v1\/w3s\/sdk\/user\/challenges\/(sig-1|tx-1)(\/approve)?$/.exec(`${method} ${path}`);
    if (challenge?.[3]) {
      seen.approve = unaes(user.key, body);
      return challenge[2] === 'sig-1' ? json(200, { data: { encrypt: aes(user.key, { data: { signature: SIGNATURE } }) } }) : json(200, {});
    }
    if (challenge) return json(200, { data: { encrypt: aes(user.key, { challengeId: challenge[2], publicKey: challengeKeys.publicKey, pinCodeUserShare: SHARE, requests: [], status: 'PENDING' }) } });
    switch (`${method} ${path}`) {
      case 'GET /config': return json(200, { appId: 'app-1' });
      case 'POST /v1/w3s/auth/deviceToken': return json(200, { data: { deviceToken: device.token, deviceEncryptionKey: device.key } });
      case 'POST /v1/w3s/auth/challenges': {
        expect(headers.get('x-user-token')).toBe(device.token);
        const { operation: asked, registeredFactors: [factor] } = JSON.parse(body);
        expect(asked).toBe('login');
        expect(factor).toMatchObject({ factor: 'email_otp', emailOtp: { destination: EMAIL, suite: 'RSA_OAEP_256_A256GCM' } });
        seen.clientKey = factor.emailOtp.publicKey;
        return json(200, { data: { challengeId: 'auth-1', operation, state: 'PENDING', submissionDeadline: 'soon', correlationState: 'corr-1' } });
      }
      case 'GET /v1/w3s/sdk/auth/challenges/auth-1':
        return json(200, { data: { encrypt: aes(device.key, { challengeId: 'auth-1', operation, state: 'PENDING', submissionDeadline: 'soon',
          requiredFactors: [{ factor: 'email_otp', emailOtpParameters: { destinationHint: 'a***@example.com', encryptedOtpToken: envelope(seen.clientKey!, otpToken) } }] }) } });
      case 'POST /v1/w3s/sdk/auth/challenges/auth-1/factors': {
        const { factorSubmissions: [{ requiredFactorIndex, emailOtpProof }] } = unaes(device.key, body);
        if (requiredFactorIndex !== 0 || emailOtpProof.code !== `${HEAD}-${CODE}` || emailOtpProof.otpToken !== otpToken || emailOtpProof.destination !== EMAIL)
          return json(400, { code: 155112, message: 'OTP value is not matched' });
        return json(200, { data: { encrypt: aes(device.key, { state: 'COMPLETED', userToken: user.token, encryptionKey: user.key, userSecret: SECRET,
          storageKey: randomBytes(32).toString('base64') }) } });
      }
      case 'GET /v1/w3s/auth/challenges/auth-1':
        expect(headers.get('x-correlation-state')).toBe('corr-1');
        return json(200, { data: { challengeId: 'auth-1', operation: 'login', state: 'COMPLETED', result: { accountRootId: 'root-1' } } });
      case 'GET /v1/w3s/wallets':
        asUser(); expect(url.searchParams.get('blockchain')).toBe(NETWORKS[network].blockchain);
        return json(200, { data: { wallets: [wallet] } });
      case `GET /v1/w3s/wallets/${wallet.id}/balances`: // both USDCs, so only the token address picks the right one
        asUser();
        return json(200, { data: { tokenBalances: [{ amount: '1.5', token: { symbol: 'EURC', tokenAddress: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1' } },
          { amount: '0.99', token: { symbol: 'USDC', tokenAddress: BASE_USDC, decimals: 6, blockchain: 'BASE' } },
          { amount: '19.99', token: { symbol: 'USDC', tokenAddress: ARC_USDC, decimals: 6, blockchain: 'ARC-TESTNET' } }] } });
      case 'POST /v1/w3s/user/sign/typedData': {
        asUser(); const { walletId, data } = JSON.parse(body);
        expect(walletId).toBe(wallet.id);
        seen.typedData = JSON.parse(data);
        if (options.overLimit) return json(400, { message: 'spend limit exceeded' });
        return json(200, { data: { challengeId: 'sig-1' } });
      }
      case 'POST /v1/w3s/user/transactions/contractExecution':
        asUser(); seen.execution = JSON.parse(body);
        return json(200, { data: { challengeId: 'tx-1' } });
      case 'GET /v1/w3s/user/challenges/tx-1': // not yet, then done, as Circle answers while its bundler works
        asUser(); seen.polls = (seen.polls ?? 0) + 1;
        return json(200, { data: { challenge: seen.polls === 1 ? { status: 'IN_PROGRESS' } : { status: 'COMPLETE', correlationIds: ['t-9'] } } });
      case 'GET /v1/w3s/transactions/t-9':
        asUser();
        return json(200, { data: { transaction } });
      case 'POST /v1/w3s/users/token/deactivate':
        asUser(); seen.deactivate = JSON.parse(body);
        return deactivate === 204 ? new Response(null, { status: 204 }) : json(deactivate, { message: 'not now' });
      default: return json(404, { message: `no route ${method} ${path}` });
    }
  };
  return { fetch: fetch as typeof globalThis.fetch, calls, seen };
}
