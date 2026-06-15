// Phantasma Link v5 - the reactive store that wraps a `PhantasmaLink5` client for React.
// It owns the connection lifecycle (pairing + session), exposes the typed `pha_*` operations,
// and keeps a rolling event/request log. One store = one dApp <-> wallet channel; the
// PhantasmaLinkProvider creates and disposes it.

import { makeAutoObservable, runInAction } from "mobx";
import {
	PhantasmaLink5,
	LinkEvent,
	bytesToBase64,
	utf8ToBytes,
	type DappMetadata,
	type LinkAccountV5,
	type WalletCapabilities,
	type WalletInfo,
	type SendTransactionParams,
	type InvokeScriptParams,
} from "phantasma-sdk-ts/link/v5";
import { verifyV5Signature } from "./verify";
import { errMsg } from "./common_utils";

/** Which v5 transport the store drives.
 * - `loopback`: same-machine desktop flow (a plaintext WebSocket to the wallet's local server,
 *   localhost:7090/phantasma/v5). No pairing - connect() talks to the wallet directly.
 * - `deeplink`: same-device web flow (universal link opens the wallet on this device).
 * - `relay`: cross-device flow (the pairing URI is shown as a QR; the wallet scans it and
 *   the session arrives over the public relay). */
export type LinkTransportKind = "loopback" | "deeplink" | "relay";

export type LinkStatus = "idle" | "pairing" | "connecting" | "connected" | "error";

export type LinkLogKind = "info" | "request" | "result" | "event" | "error";

export interface LinkLogEntry {
	id: string;
	ts: number;
	kind: LinkLogKind;
	label: string;
	detail?: string;
}

export interface PhantasmaLinkConfig {
	/** dApp identity shown in the wallet's approval UI and embedded in the pairing URI. */
	dapp: DappMetadata;
	/** Initial transport; defaults to `deeplink`. Switchable at runtime via setTransport(). */
	transport?: LinkTransportKind;
	/** Relay WebSocket URL for the `relay` transport; defaults to the public relay. */
	relayUrl?: string;
	/** Universal-link host for the `deeplink` pairing URI; defaults to link.phantasma.info. */
	host?: string;
}

let logSeq = 0;
const MAX_LOG = 200;

export class PhantasmaLinkStore {
	readonly dapp: DappMetadata;
	transport: LinkTransportKind;
	relayUrl?: string;
	host?: string;

	// All observable fields carry an explicit initializer: under the package's ES2017 target
	// (no useDefineForClassFields) an uninitialized `field?: T` is not emitted as an own property,
	// so makeAutoObservable would never see it and assignments to it would not be reactive.
	client: PhantasmaLink5 | undefined = undefined;
	status: LinkStatus = "idle";
	account: LinkAccountV5 | undefined = undefined;
	capabilities: WalletCapabilities | undefined = undefined;
	walletInfo: WalletInfo | undefined = undefined;
	pairingUri: string | undefined = undefined;
	/** Label of the operation currently in flight (for per-button spinners), if any. */
	busyOp: string | undefined = undefined;
	logs: LinkLogEntry[] = [];

	private unsubscribe: (() => void) | undefined = undefined;

	constructor(config: PhantasmaLinkConfig) {
		this.dapp = config.dapp;
		this.transport = config.transport ?? "deeplink";
		this.relayUrl = config.relayUrl;
		this.host = config.host;
		makeAutoObservable(this, {}, { autoBind: true });
	}

	get connected(): boolean {
		return this.status === "connected" && !!this.account;
	}

	get address(): string | undefined {
		return this.account?.address;
	}

	log(kind: LinkLogKind, label: string, detail?: string): void {
		this.logs.unshift({ id: `${++logSeq}`, ts: Date.now(), kind, label, detail });
		if (this.logs.length > MAX_LOG) {
			this.logs.length = MAX_LOG;
		}
	}

	clearLogs(): void {
		this.logs = [];
	}

	/** Build (or rebuild) the client for the current transport and restore any cached session. */
	async init(): Promise<void> {
		await this.buildClient();
	}

	async setTransport(kind: LinkTransportKind): Promise<void> {
		if (kind === this.transport && this.client) {
			return;
		}
		this.transport = kind;
		await this.buildClient();
	}

	private async buildClient(): Promise<void> {
		this.teardownClient();
		runInAction(() => {
			this.status = "idle";
			this.account = undefined;
			this.capabilities = undefined;
			this.walletInfo = undefined;
			this.pairingUri = undefined;
		});

		try {
			const client =
				this.transport === "deeplink"
					? await PhantasmaLink5.webDeeplink({ dapp: this.dapp, host: this.host })
					: this.transport === "loopback"
						? PhantasmaLink5.loopback()
						: PhantasmaLink5.relayEcdh({ dapp: this.dapp, url: this.relayUrl });

			const unsub = client.onEvent((event, data) => this.onLinkEvent(event, data));
			runInAction(() => {
				this.client = client;
				this.unsubscribe = unsub;
				this.pairingUri = client.pairingUri;
				// webDeeplink hydrates a cached account synchronously across reloads.
				if (client.account) {
					this.account = client.account;
					this.capabilities = client.capabilities;
					this.status = "connected";
					this.log("info", "Restored session", client.account.address);
				} else {
					this.log("info", `Client ready (${this.transport})`);
				}
			});
		} catch (e) {
			runInAction(() => {
				this.status = "error";
				this.log("error", "init", errMsg(e));
			});
		}
	}

	private teardownClient(): void {
		try {
			this.unsubscribe?.();
		} catch {
			/* ignore */
		}
		this.unsubscribe = undefined;
		try {
			this.client?.close();
		} catch {
			/* ignore */
		}
		this.client = undefined;
	}

	private onLinkEvent(event: string, data: unknown): void {
		runInAction(() => {
			this.log("event", event, summarize(data));
			if (event === LinkEvent.SessionEstablished) {
				// The client adopts the pushed connect result; mirror it into the store.
				if (this.client?.account) {
					this.account = this.client.account;
					this.capabilities = this.client.capabilities;
					this.status = "connected";
				}
			} else if (event === LinkEvent.AccountsChanged) {
				if (this.client?.account) {
					this.account = this.client.account;
				}
			} else if (event === LinkEvent.SessionDeleted || event === LinkEvent.SessionExpired) {
				this.account = undefined;
				this.status = "idle";
			}
		});
	}

	/** Start a connection.
	 * - `relay`: surfaces the pairing QR and waits for the wallet to scan it (the session
	 *   arrives as an unsolicited SessionEstablished event - do NOT call pha_connect first,
	 *   the channel key is not established until the wallet's hop arrives).
	 * - `deeplink`: runs pha_connect, which resumes a stored session or opens the wallet. */
	async connect(): Promise<void> {
		if (!this.client) {
			await this.buildClient();
		}
		if (!this.client) {
			return;
		}

		if (this.transport === "relay") {
			runInAction(() => {
				this.status = "pairing";
				this.pairingUri = this.client?.pairingUri;
			});
			this.log("info", "Waiting for the wallet to scan the pairing QR");
			return;
		}

		runInAction(() => {
			this.status = this.account ? this.status : "connecting";
		});
		this.log("request", "connect");
		try {
			// Pass the dApp metadata explicitly: the loopback factory carries no default dApp
			// (unlike webDeeplink/relayEcdh), and connect() requires it. Harmless for the other
			// transports - it is the same value their factory already stored.
			const result = await this.client.connect(this.dapp);
			runInAction(() => {
				this.account = result.account;
				this.capabilities = result.capabilities;
				this.walletInfo = result.wallet;
				this.status = "connected";
				this.log("result", "connect", result.account.address);
			});
		} catch (e) {
			runInAction(() => {
				this.status = this.account ? "connected" : "error";
				this.log("error", "connect", errMsg(e));
			});
		}
	}

	/** Abort an in-progress pairing/connect and reset for a fresh attempt. Rebuilding the client
	 * also mints a new pairing URI for the relay transport, so "try again" starts clean. */
	async cancel(): Promise<void> {
		this.log("info", "connect cancelled");
		await this.buildClient();
	}

	async disconnect(): Promise<void> {
		if (this.client) {
			try {
				await this.client.disconnect();
				this.log("result", "disconnect");
			} catch (e) {
				this.log("error", "disconnect", errMsg(e));
			}
		}
		runInAction(() => {
			this.account = undefined;
			this.capabilities = undefined;
			this.status = "idle";
		});
	}

	// ----- operations (each logs request/result/error and returns the result or undefined) -----

	getChains() {
		return this.run("getChains", () => this.client!.getChains(), (r) =>
			`current ${r.current}, nexus ${r.nexus}, ${r.chains.length} chain(s)`,
		);
	}

	getWalletInfo() {
		return this.run(
			"getWalletInfo",
			async () => {
				const info = await this.client!.getWalletInfo();
				// Keep the observable in sync so consumers can render the wallet name/version.
				runInAction(() => {
					this.walletInfo = info;
				});
				return info;
			},
			(r) => `${r.name} v${r.version}`,
		);
	}

	getAccounts() {
		return this.run("getAccounts", () => this.client!.getAccounts(), (r) => `${r.accounts.length} account(s)`);
	}

	signMessage(message: string) {
		return this.run(
			"signMessage",
			async () => {
				// No `display`: the wallet decodes the UTF-8 message for its consent preview, so
				// passing the same text as a display hint would show it twice. `display` is for a
				// human-friendly label that DIFFERS from the raw bytes (e.g. a binary message).
				const result = await this.client!.signMessage({
					message: bytesToBase64(utf8ToBytes(message)),
				});
				const verified = verifyV5Signature(message, result, this.account?.address);
				return { signature: result.signature, verified };
			},
			(r) => `verified ${r.verified === null ? "n/a" : r.verified ? "VALID" : "INVALID"} | ${r.signature.slice(0, 16)}...`,
		);
	}

	sendTransaction(params: SendTransactionParams) {
		return this.run("sendTransaction", () => this.client!.sendTransaction(params), (r) => `hash ${r.hash}`);
	}

	invokeScript(params: InvokeScriptParams) {
		return this.run("invokeScript", () => this.client!.invokeScript(params), (r) => `${r.results.length} result(s)`);
	}

	private async run<T>(label: string, fn: () => Promise<T>, describe: (r: T) => string): Promise<T | undefined> {
		if (!this.client) {
			this.log("error", label, "not connected");
			return undefined;
		}
		runInAction(() => {
			this.busyOp = label;
		});
		this.log("request", label);
		try {
			const result = await fn();
			runInAction(() => {
				this.busyOp = undefined;
				this.log("result", label, describe(result));
			});
			return result;
		} catch (e) {
			runInAction(() => {
				this.busyOp = undefined;
				this.log("error", label, errMsg(e));
			});
			return undefined;
		}
	}

	dispose(): void {
		this.teardownClient();
	}
}

function summarize(data: unknown): string | undefined {
	if (data === undefined || data === null) {
		return undefined;
	}
	try {
		const s = JSON.stringify(data);
		return s.length > 160 ? `${s.slice(0, 157)}...` : s;
	} catch {
		return undefined;
	}
}
