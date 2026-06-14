// @phantasma/link-react - React bindings + UI for the Phantasma Link v5 dApp<->wallet protocol.
// Wrap your app in <PhantasmaLinkProvider config={{ dapp }}>, drop a <ConnectWidget /> in the
// header, and read the live session via usePhantasmaLink() (in an `observer` component). The
// store exposes the typed pha_* operations directly.

export { PhantasmaLinkStore } from "./lib/store";
export type {
	PhantasmaLinkConfig,
	LinkTransportKind,
	LinkStatus,
	LinkLogKind,
	LinkLogEntry,
} from "./lib/store";

export { PhantasmaLinkProvider, usePhantasmaLink } from "./lib/provider";
export type { PhantasmaLinkProviderProps } from "./lib/provider";

export { ConnectWidget } from "./components/ConnectWidget";
export { PairingModal } from "./components/PairingModal";
export type { PairingModalProps } from "./components/PairingModal";

export { str_cut, clip_copy } from "./lib/common_utils";

// MobX re-exports so a consumer that builds its own observable stores / observer components
// shares THIS package's single MobX instance. Important when the package is linked locally
// (a `file:` dependency keeps its own node_modules, which would otherwise be a second copy).
export { observer } from "mobx-react";
export { makeAutoObservable, runInAction } from "mobx";

// Re-export the slice of the v5 protocol surface consumers most often need next to the store.
export {
	LinkEvent,
	TxFormat,
	SignatureKind,
	bytesToBase64,
	base64ToBytes,
	utf8ToBytes,
} from "phantasma-sdk-ts/link/v5";
export type {
	DappMetadata,
	LinkAccountV5,
	LinkBalance,
	WalletCapabilities,
	WalletInfo,
	ConnectResult,
	SendTransactionParams,
	SignMessageParams,
	InvokeScriptParams,
} from "phantasma-sdk-ts/link/v5";
