// A minimal screen: log in with the emailed code, read the USDC balance, pay one x402 resource.
// Not run yet: it was written beside the library and has not been built or put on a device. It needs an Expo dev build (not Expo Go,
// because react-native-keychain is a native module) with: expo, react-native, react-native-keychain, react-native-get-random-values,
// viem, @x402/core, @x402/evm and this package.
import 'react-native-get-random-values'; // crypto.getRandomValues, before anything that makes keys
import { useEffect, useMemo, useState } from 'react';
import { Button, SafeAreaView, Text, TextInput } from 'react-native';
import * as Keychain from 'react-native-keychain';
import { createAgentWallet, keychainStorage, type WalletInfo } from 'agent-wallet-mobile';
import { payOnce, type Terms } from './x402';

// What this app agrees to pay, checked against every 402 before Circle is asked to sign. Put your own seller and payee here.
const RESOURCE = 'https://seller.example/paid';
const TERMS: Terms = { network: 'eip155:5042002', asset: '0x3600000000000000000000000000000000000000', name: 'USDC', version: '2',
  maxAmount: 10_000n /* 0.01 USDC */, payTo: '0x0000000000000000000000000000000000000000' };

export default function App() {
  const agent = useMemo(() => createAgentWallet({ network: 'arc', storage: keychainStorage(Keychain) }), []);
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [note, setNote] = useState('');

  const run = (what: string, work: () => Promise<void>) => { setNote(what); work().catch(error => setNote(error instanceof Error ? error.message : String(error))); };
  const refresh = async () => { setNote(`${await agent.balance()} USDC`); };
  // A stored session that has expired reads as logged out: Circle issues no refresh token, so the user logs in again.
  useEffect(() => { agent.wallet().then(setWallet, () => setWallet(null)); }, [agent]);

  if (!wallet) return (
    <SafeAreaView style={{ margin: 24, gap: 12 }}>
      {codeSent
        ? <TextInput value={code} onChangeText={setCode} placeholder="Six digits from the email" keyboardType="number-pad" textContentType="oneTimeCode" maxLength={6} />
        // The RSA key takes seconds in JS, so it starts being made as soon as the field has focus.
        : <TextInput value={email} onChangeText={setEmail} onFocus={() => void agent.login.prepare().catch(() => undefined)} placeholder="Email" autoCapitalize="none" keyboardType="email-address" />}
      {codeSent
        ? <Button title="Log in" onPress={() => run('Logging in…', async () => { setWallet(await agent.login.finish(code)); setCode(''); setEmail(''); setCodeSent(false); setNote(''); })} />
        : <Button title="Send code" onPress={() => run('Sending the code…', async () => { await agent.login.start(email); setCodeSent(true); setNote(''); })} />}
      <Text>{note}</Text>
    </SafeAreaView>
  );
  return (
    <SafeAreaView style={{ margin: 24, gap: 12 }}>
      <Text selectable>{wallet.address}</Text>
      <Text>{wallet.blockchain}, session until {new Date(wallet.expiresAt).toLocaleDateString()}</Text>
      <Button title="Balance" onPress={() => run('Asking Circle…', refresh)} />
      <Button title="Pay 0.01 USDC" onPress={() => run('Paying…', async () => {
        const { body, transaction } = await payOnce(RESOURCE, await agent.x402Signer(), TERMS);
        setNote(`${JSON.stringify(body).slice(0, 200)}\n${transaction ?? 'no transaction hash in the answer'}`);
      })} />
      <Button title="Log out" onPress={() => run('Logging out…', async () => { await agent.logout(); setWallet(null); setNote(''); })} />
      <Text selectable>{note}</Text>
    </SafeAreaView>
  );
}
