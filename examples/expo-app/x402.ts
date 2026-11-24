// One paid GET over x402 ("exact" scheme, EIP-3009), with the app's own checks run before the signer is ever asked. The checks are
// the spending policy: Circle signs whatever typed data a valid session sends, so a 402 that fails them must never reach Circle.
// Only @x402/core/client is imported: @x402/fetch pulls in @x402/core/http, whose dynamic import() Hermes cannot compile.
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import type { X402Signer } from '../../src/index.js'; // in an app: from 'agent-wallet-mobile'

// What the app is willing to pay: one token on one chain (named as its EIP-712 domain), up to maxAmount base units, to one payee.
// The seller chooses how long a signed payment stays valid; maxTimeoutSeconds caps that, an hour unless the app says otherwise.
export type Terms = { network: `${string}:${string}`; asset: string; name: string; version: string; maxAmount: bigint; payTo: string; maxTimeoutSeconds?: number };
type Requirement = { scheme: string; network: string; asset: string; amount: string; payTo: string; maxTimeoutSeconds?: number; extra?: Record<string, unknown> };

export function checkRequirement(requirement: Requirement, terms: Terms): void {
  if (requirement.scheme !== 'exact') throw new Error('Refused to pay: scheme');
  if (requirement.network !== terms.network) throw new Error('Refused to pay: network');
  if (requirement.asset.toLowerCase() !== terms.asset.toLowerCase()) throw new Error('Refused to pay: asset');
  const extra = requirement.extra ?? {};
  if (extra.name !== terms.name || extra.version !== terms.version) throw new Error('Refused to pay: token domain');
  if (extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== 'eip3009') throw new Error('Refused to pay: transfer method');
  if (!/^\d+$/.test(requirement.amount)) throw new Error('Refused to pay: amount'); // BigInt alone would take hex and padding
  const amount = BigInt(requirement.amount);
  if (amount <= 0n || amount > terms.maxAmount) throw new Error('Refused to pay: amount');
  if (requirement.payTo.toLowerCase() !== terms.payTo.toLowerCase()) throw new Error('Refused to pay: payTo');
  const timeout = requirement.maxTimeoutSeconds;
  if (timeout !== undefined && !(Number.isFinite(timeout) && timeout <= (terms.maxTimeoutSeconds ?? 3600))) throw new Error('Refused to pay: timeout');
}

export async function payOnce(url: string, signer: X402Signer, terms: Terms, doFetch: typeof fetch = fetch): Promise<{ body: unknown; transaction: string | null }> {
  let refusal: Error | undefined; // our own reason: the x402 client wraps a hook's abort in its own text
  let signed = false;
  const client = new x402Client();
  client.setSpendControls({ allowedAssets: [{ network: terms.network, asset: terms.asset, maxAmountPerPayment: terms.maxAmount.toString() }] });
  registerExactEvmScheme(client, { signer });
  client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    try { checkRequirement(selectedRequirements, terms); } catch (error) {
      refusal = error as Error;
      return { abort: true as const, reason: refusal.message };
    }
  });
  const http = new x402HTTPClient(client);
  let response = await doFetch(url);
  if (response.status === 402) {
    let body: unknown;
    try { body = JSON.parse(await response.text()); } catch { body = undefined; }
    const required = http.getPaymentRequiredResponse(name => response.headers.get(name), body);
    let payload;
    try { payload = await client.createPaymentPayload(required); } catch (error) {
      // The client's own spend controls refuse before the hook runs; either way nothing was signed. The wallet's own errors
      // (Circle's spending limit, an expired session) pass through with their code.
      throw refusal ?? ((error as Error).name === 'AgentWalletError' ? error : new Error(`Refused to pay: ${(error as Error).message}`));
    }
    signed = true; // from here the seller may hold the signature, whether or not its answer arrives
    try { response = await doFetch(url, { headers: http.encodePaymentSignatureHeader(payload) }); } catch (error) {
      throw new Error(`A payment was signed and may still be settled, but the request failed: ${(error as Error).message}`);
    }
  }
  let transaction: string | null = null;
  try {
    const settled = http.getPaymentSettleResponse(name => response.headers.get(name));
    transaction = settled.success === false ? null : settled.transaction || null;
  } catch { /* no settlement header */ }
  // Once the seller holds a signed payment it can settle it whatever it answers, so a failure from here on says so.
  const paid = signed ? `A payment was signed${transaction ? ` and settled (${transaction})` : ' and may still be settled'}, but ` : '';
  if (response.status !== 200) throw new Error(`${paid}${paid ? 't' : 'T'}he seller answered ${response.status}`);
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error(`${paid}${paid ? 't' : 'T'}he seller's answer was not JSON`); }
  return { body, transaction };
}
