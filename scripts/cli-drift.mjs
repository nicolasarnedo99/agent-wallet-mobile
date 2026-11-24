// Circle documents none of the calls this client makes: they were read out of @circle-fin/cli 1.4.0. This downloads the newest
// CLI from npm and checks that every path, header and field name this client depends on still appears in its bundle. A missing
// string means a CLI release changed that call, and the client should be re-read against the new source before it breaks.
// It reads the published package only: nothing is sent to Circle.
//
//   node scripts/cli-drift.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const READ_AT = '1.4.0';
const NEEDED = [
  // hosts and proxies
  'agentic-wallet.circle.com', '/proxy/live-user', 'x402/discovery/resources',
  // login
  'auth/deviceToken', '/v1/w3s/auth/challenges', '/v1/w3s/sdk/auth/challenges/', '/factors', 'user/initialize', 'RSA_OAEP_256_A256GCM',
  'encryptedOtpToken', 'X-Correlation-State', 'accountType', 'ARC-TESTNET', 'MONAD-TESTNET',
  // session and wallet
  'X-User-Token', 'X-App-Id', 'X-Device-Id', '/v1/w3s/wallets', '/balances', 'token/deactivate',
  // signing, calls and transfers
  '/v1/w3s/user/sign/typedData', '/v1/w3s/sdk/user/challenges/', '/approve', 'pinCodeUserShare', 'pinType', 'additionalPinhash',
  '/v1/w3s/user/transactions/contractExecution', 'callData', '/v1/w3s/user/transactions/transfer', 'destinationAddress', 'feeLevel',
  '/v1/w3s/user/challenges/', 'correlationIds', '/v1/w3s/transactions/', '/fund',
  // limits
  '/v1/policy/limit', '/v1/policy/budget', '/v1/policy', 'STABLECOIN_TRANSFER', 'TRANSFER_LIMIT', 'CONTRACT_ALLOWLIST', 'RECIPIENT_BLOCKLIST',
];

const dir = mkdtempSync(join(tmpdir(), 'cli-drift-'));
execFileSync('npm', ['pack', '@circle-fin/cli@latest', '--silent', '--pack-destination', dir], { stdio: ['ignore', 'ignore', 'inherit'] });
const tarball = readdirSync(dir).find(name => name.endsWith('.tgz'));
execFileSync('tar', ['-xzf', join(dir, tarball), '-C', dir, 'package/package.json', 'package/dist/index.js']);
const { version } = JSON.parse(readFileSync(join(dir, 'package/package.json'), 'utf8'));
const bundle = readFileSync(join(dir, 'package/dist/index.js'), 'utf8');
const missing = NEEDED.filter(text => !bundle.includes(text));

console.log(`@circle-fin/cli ${version} (this client was read against ${READ_AT}): ${NEEDED.length - missing.length} of ${NEEDED.length} strings found`);
if (missing.length) {
  console.error(`Gone from the CLI, so the calls that use them may have changed:\n${missing.map(text => `  ${text}`).join('\n')}`);
  process.exitCode = 1;
} else if (version !== READ_AT) {
  console.log('A newer CLI, and nothing this client depends on has disappeared. New or renamed fields would not show up here.');
}
