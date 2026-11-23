// A live smoke test of the built package against Circle on Arc testnet: log in, read the wallet and the balance, pay one x402
// resource 0.01 USDC, optionally send one contract call, log out. Run it yourself, in your own terminal:
//
//   npm run smoke            # the payment
//   npm run smoke -- --call  # the payment, then a zero USDC approve through call() and transaction()
//   npm run smoke -- --fund --transfer   # also ask the faucet for USDC, and transfer 0.01 USDC to the payee
//   npm run smoke -- --fund --deploy     # for a brand-new wallet: faucet first, then the transaction that deploys it, then the payment
//   npm run smoke -- --base --call --transfer --limits   # Base mainnet, REAL USDC: the payment costs 0.01, the transfer goes to
//                                                        # the wallet itself, and --limits sets a small cap, sees Circle refuse, resets
//
// SMOKE_URL is the x402 resource to pay and SMOKE_PAY_TO the address it is paid at (SMOKE_BASE_URL and SMOKE_BASE_PAY_TO with --base);
// put them in .env.local, which git ignores.
// The email and the code are typed with echo off, go to the library and nowhere else. The session stays in this process's
// memory. smoke-result.json gets the address, the balances and the transaction hashes: nothing secret.
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { createPublicClient, encodeFunctionData, erc20Abi, http, parseEventLogs } from 'viem';
import { AgentWalletError, NETWORKS, createAgentWallet, memoryStorage } from '../dist/index.js';
import { payOnce } from '../examples/expo-app/x402.ts';

// The one seller this script pays. payOnce refuses any 402 that differs from TERMS before Circle is asked to sign.
const BASE = process.argv.includes('--base');
const NET = BASE ? 'base' : 'arc';
const RESOURCE = BASE ? process.env.SMOKE_BASE_URL : process.env.SMOKE_URL;
const PAYEE = BASE ? process.env.SMOKE_BASE_PAY_TO : process.env.SMOKE_PAY_TO;
const USDC = NETWORKS[NET].usdc;
const TERMS = { network: `eip155:${NETWORKS[NET].chainId}`, asset: USDC, name: BASE ? 'USD Coin' : 'USDC', version: '2', maxAmount: 10_000n /* 0.01 USDC */, payTo: PAYEE };
const chain = createPublicClient({ transport: http(BASE ? 'https://mainnet.base.org' : 'https://rpc.testnet.arc.io') });

export async function ask(question) {
  process.stdout.write(question);
  const typed = createInterface({ input: process.stdin, output: new Writable({ write: (_chunk, _encoding, done) => done() }), terminal: true });
  try { return await typed.question(''); } finally { typed.close(); process.stdout.write('\n'); }
}
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
// The transaction as the chain has it, not as Circle or the seller reports it: mined, successful, and carrying the USDC event we meant.
export async function onChain(hash, eventName, matches) {
  const receipt = await chain.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== 'success') throw new Error(`${hash} is on-chain but reverted`);
  const found = parseEventLogs({ abi: erc20Abi, eventName, logs: receipt.logs }).some(log => same(log.address, USDC) && matches(log.args));
  if (!found) throw new Error(`${hash} succeeded but has no matching USDC ${eventName}`);
  return Number(receipt.blockNumber);
}

async function main() {
  if (!RESOURCE || !/^0x[0-9a-fA-F]{40}$/.test(PAYEE ?? '')) throw new Error('Set the seller URL and its payee in .env.local (see the top of this file)');
  if (BASE && process.argv.includes('--fund')) throw new Error('There is no faucet on mainnet');
  if (!BASE && process.argv.includes('--limits')) throw new Error('Limits exist on mainnet only: add --base');
  if (BASE) console.log('BASE MAINNET: this run spends 0.01 real USDC.');
  const withCall = process.argv.includes('--call');
  const result = { package: 'dist/ built from this checkout', network: NET, ranAt: new Date().toISOString() };
  const agent = createAgentWallet({ network: NET });
  agent.login.prepare().catch(() => undefined);

  await agent.login.start(await ask('Email of your Circle agent wallet account (typing is hidden): '));
  console.log('Circle emailed a code.');
  for (let attempt = 1; ; attempt++) {
    try { await agent.login.finish(await ask('The code (typing is hidden): ')); break; } catch (error) {
      if (attempt === 3 || !(error instanceof AgentWalletError) || !['wrong_code', 'invalid_input'].includes(error.code)) throw error;
      console.log(error.message);
    }
  }
  try {
    const wallet = await agent.wallet();
    result.address = wallet.address;
    console.log(`login    ok: ${wallet.address} on ${wallet.blockchain}, session until ${new Date(wallet.expiresAt).toISOString().slice(0, 10)}`);
    result.balanceBefore = await agent.balance();
    console.log(`balance  ${result.balanceBefore} USDC`);

    if (process.argv.includes('--fund')) {
      const before = Number(await agent.balance());
      await agent.fund();
      let now = before;
      for (let i = 0; i < 30 && now <= before; i++) { await new Promise(done => setTimeout(done, 2000)); now = Number(await agent.balance()); }
      result.fund = now > before ? `arrived: balance ${before} -> ${now}` : 'accepted by Circle, nothing arrived within a minute';
      console.log(`fund     ${result.fund}`);
    }
    if (process.argv.includes('--deploy')) {
      const deployed = await agent.deploy();
      const deployBlock = await onChain(deployed.hash, 'Approval', args => same(args.owner, wallet.address) && same(args.spender, wallet.address) && args.value === 0n);
      const code = await chain.getCode({ address: wallet.address });
      if (!code || code === '0x') throw new Error(`${deployed.hash} succeeded but the wallet still has no code`);
      result.deploy = { hash: deployed.hash, block: deployBlock };
      console.log(`deploy   ok: ${deployed.hash} (block ${deployBlock}, the wallet now has code on-chain)`);
    }

    const paid = await payOnce(RESOURCE, await agent.x402Signer(), TERMS);
    if (!paid.transaction) throw new Error('The seller answered 200 but named no transaction');
    const block = await onChain(paid.transaction, 'Transfer', args => same(args.from, wallet.address) && same(args.to, PAYEE) && args.value === 10_000n);
    result.payment = { hash: paid.transaction, block };
    console.log(`payment  ok: ${paid.transaction} (block ${block}, 0.01 USDC from the wallet to ${PAYEE})`);
    console.log(`         the seller answered ${JSON.stringify(paid.body).slice(0, 160)}`);

    if (withCall) {
      const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PAYEE, 0n] });
      const sent = await agent.call({ to: USDC, data });
      const status = await agent.transaction(sent.transactionId);
      const callBlock = await onChain(sent.hash, 'Approval', args => same(args.owner, wallet.address) && same(args.spender, PAYEE) && args.value === 0n);
      result.call = { hash: sent.hash, block: callBlock, transactionId: sent.transactionId, state: status.state };
      console.log(`call     ok: ${sent.hash} (block ${callBlock}, approve 0 USDC), Circle transaction ${sent.transactionId} is ${status.state}`);
      if (status.hash !== sent.hash) throw new Error(`transaction() reports hash ${status.hash}, call() returned ${sent.hash}`);
    }
    if (process.argv.includes('--transfer')) {
      const to = BASE ? wallet.address : PAYEE; // on mainnet the money goes back to the wallet it came from
      const moved = await agent.transfer({ to, amount: '0.01' });
      const transferBlock = await onChain(moved.hash, 'Transfer', args => same(args.from, wallet.address) && same(args.to, to) && args.value === 10_000n);
      result.transfer = { hash: moved.hash, block: transferBlock, transactionId: moved.transactionId };
      console.log(`transfer ok: ${moved.hash} (block ${transferBlock}, 0.01 USDC from the wallet to ${to})`);
    }
    if (process.argv.includes('--limits')) {
      const CAP = { perTx: '0.005', daily: '0.01', weekly: '0.05', monthly: '0.1' };
      const custom = rows => rows.filter(row => row.origin === 'CUSTOM');
      result.limits = { before: await agent.limits.read(), budget: await agent.limits.budget() };
      console.log(`limits   now: ${JSON.stringify(result.limits.before)}`);
      console.log(`         budget: ${JSON.stringify(result.limits.budget)}`);
      if (custom(result.limits.before).length) throw new Error('A custom limit is already set and this test would remove it: reset it yourself first');
      await agent.limits.owner.start(await ask('Owner login for changing limits. The same email again (typing is hidden): '));
      await agent.limits.owner.finish(await ask('The second code (typing is hidden): '));
      try {
        await agent.limits.set(CAP);
        result.limits.set = custom(await agent.limits.read());
        if (!result.limits.set.some(row => row.perTx === CAP.perTx)) throw new Error('limits.set() returned but Circle shows no such limit');
        console.log(`limits   set: ${JSON.stringify(result.limits.set)}`);
        const again = await agent.limits.set({ ...CAP, monthly: '1' }).then(() => 'REPLACED IT', error => error.code);
        console.log(`limits   a second set() without reset(): ${again}`);
        // Twice the cap per payment: Circle should refuse to sign the payment and to send the transfer, and no money should move.
        const signing = await payOnce(RESOURCE, await agent.x402Signer(), TERMS).then(paid => `NOT REFUSED: paid ${paid.transaction}`, error => error.message);
        const sending = await agent.transfer({ to: wallet.address, amount: '0.01' }).then(sent => `NOT REFUSED: sent ${sent.hash}`, error => `${error.code}: ${error.message}`);
        result.limits.refused = { signing, sending };
        console.log(`limits   0.01 USDC payment under a 0.005 cap: ${signing}`);
        console.log(`limits   0.01 USDC transfer under a 0.005 cap: ${sending}`);
      } finally {
        await agent.limits.reset().catch(error => console.error(`LIMIT NOT RESET (${error.message}). Run: circle wallet limit reset --address ${wallet.address} --chain BASE`));
        result.limits.after = await agent.limits.read();
        console.log(`limits   after reset: ${JSON.stringify(result.limits.after)}`);
        if (custom(result.limits.after).length) console.error(`A CUSTOM LIMIT IS STILL SET. Run: circle wallet limit reset --address ${wallet.address} --chain BASE`);
      }
    }
    result.balanceAfter = await agent.balance();
    console.log(`balance  ${result.balanceAfter} USDC`);
  } finally {
    // Log out whatever happened above, then ask Circle once more with the old session to see that it is really revoked.
    const old = await agent.session();
    await agent.logout('local');
    const storage = { ...memoryStorage(), get: async () => JSON.stringify(old) };
    const refused = await createAgentWallet({ network: NET, storage }).balance().then(() => null, error => error);
    result.logout = refused instanceof AgentWalletError && refused.status ? `revoked: Circle answers ${refused.status} to the old session` : 'NOT REVOKED: Circle still answers the old session';
    console.log(`logout   ${result.logout}`);
    writeFileSync(new URL('../smoke-result.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
  }
  if (!result.logout.startsWith('revoked')) throw new Error('logout did not revoke the session at Circle');
}

if (import.meta.url === `file://${process.argv[1]}`) main().then(() => console.log('Smoke test passed. Results are in smoke-result.json.'), error => {
  console.error(`SMOKE TEST FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
