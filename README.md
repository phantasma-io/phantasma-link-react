# @phantasma/link-react

React bindings and UI for the [Phantasma Link](https://github.com/phantasma-io) v5
dApp&harr;wallet protocol. Wrap your app once, drop in a connect button, and call the typed
`pha_*` methods through a small reactive store.

It is a thin, v5-first layer over `phantasma-sdk-ts`'s `PhantasmaLink5` client: the store binds
the client's session/account/events to React (via MobX), and the components render the pairing
QR/link and the account menu. There is no protocol logic here that the SDK does not already own.

## Install

```sh
npm install @phantasma/link-react
```

Peer dependencies: `react` and `react-dom` (>=18).

> **Local SDK during development.** Phantasma Link v5 is not yet published to npm, so this
> package currently depends on the SDK via `file:../phantasma-sdk-ts` (a sibling checkout of
> `phantasma-io/phantasma-sdk-ts`). Once the SDK ships v5 to npm, the dependency flips to a
> version range.

## Quick start

```tsx
import { PhantasmaLinkProvider, ConnectWidget } from "@phantasma/link-react";

const dapp = { name: "My dApp", url: "https://mydapp.example" };

export function App() {
  return (
    <PhantasmaLinkProvider config={{ dapp, transport: "deeplink" }}>
      <header>
        <ConnectWidget />
      </header>
      {/* ... */}
    </PhantasmaLinkProvider>
  );
}
```

## Transports

- **`deeplink`** (same device): the pairing URI is a domain-verified universal link that opens
  the wallet on this device. Best when the dApp runs on the phone that holds the wallet.
- **`relay`** (cross device): the pairing URI is rendered as a QR; the wallet on another device
  scans it and the session arrives over the public relay. Best for a desktop dApp + phone wallet.

Switch at runtime with `store.setTransport("relay")`.

## Using the session

`usePhantasmaLink()` returns the store. Read its observable fields inside a `mobx-react`
`observer` component, and call the operations directly:

```tsx
import { observer } from "mobx-react";
import { usePhantasmaLink } from "@phantasma/link-react";

export const Demo = observer(function Demo() {
  const link = usePhantasmaLink();
  if (!link.connected) return <p>Not connected</p>;
  return (
    <div>
      <p>{link.address}</p>
      <button onClick={() => link.signMessage("hello")}>Sign message</button>
      <button onClick={() => link.getChains()}>Get chains</button>
    </div>
  );
});
```

Operations: `connect()`, `disconnect()`, `getChains()`, `getWalletInfo()`, `getAccounts()`,
`signMessage(text)`, `sendTransaction(params)`, `invokeScript(params)`. Each appends to
`store.logs` (a rolling request/result/event log) and surfaces failures on `store.error`.

## License

MIT
