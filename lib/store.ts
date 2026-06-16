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
	type UnmatchedResponse,
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

/** localStorage key under which the store remembers the user's chosen transport across reloads.
 * The deeplink flow navigates to the wallet and back, reloading the page (spec §17, same-device
 * hop); without this the selector snaps back to the config default and shows "not connected"
 * until the user re-picks the transport, even though the session is still live. */
const TRANSPORT_STORAGE_KEY = "phantasma.link.v5.transport";

function loadStoredTransport(): LinkTransportKind | undefined {
	if (typeof window === "undefined") {
		return undefined;
	}
	try {
		const v = window.localStorage.getItem(TRANSPORT_STORAGE_KEY);
		return v === "loopback" || v === "deeplink" || v === "relay" ? v : undefined;
	} catch {
		return undefined;
	}
}

function saveStoredTransport(kind: LinkTransportKind): void {
	if (typeof window === "undefined") {
		return;
	}
	try {
		window.localStorage.setItem(TRANSPORT_STORAGE_KEY, kind);
	} catch {
		/* storage unavailable (private mode) - persistence is best-effort */
	}
}

/** localStorage key for the single in-flight deeplink operation. Deeplink is strict ping-pong
 * (you navigate to the wallet and back, so there is at most one outstanding op). It is persisted
 * before the wallet hop so the op's result can still be presented if the page reloads while the
 * wallet is open and the original request promise is lost. */
const OUTSTANDING_OP_KEY = "phantasma.link.v5.outstandingOp";

/** Drop a remembered op older than this; a never-answered op must not later mislabel an
 * unrelated response delivered in a future session. */
const OUTSTANDING_OP_TTL_MS = 10 * 60 * 1000;

interface StoredOp {
	label: string;
	message?: string;
	ts: number;
}

function loadOutstandingOp(): StoredOp | undefined {
	if (typeof window === "undefined") {
		return undefined;
	}
	try {
		const raw = window.localStorage.getItem(OUTSTANDING_OP_KEY);
		if (!raw) {
			return undefined;
		}
		const parsed = JSON.parse(raw) as StoredOp;
		if (typeof parsed?.label !== "string" || typeof parsed?.ts !== "number") {
			return undefined;
		}
		return Date.now() - parsed.ts > OUTSTANDING_OP_TTL_MS ? undefined : parsed;
	} catch {
		return undefined;
	}
}

function saveOutstandingOp(op: Omit<StoredOp, "ts">): void {
	if (typeof window === "undefined") {
		return;
	}
	try {
		window.localStorage.setItem(OUTSTANDING_OP_KEY, JSON.stringify({ ...op, ts: Date.now() }));
	} catch {
		/* best-effort */
	}
}

function clearOutstandingOp(): void {
	if (typeof window === "undefined") {
		return;
	}
	try {
		window.localStorage.removeItem(OUTSTANDING_OP_KEY);
	} catch {
		/* best-effort */
	}
}

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
		// Restore the transport the user last chose. The deeplink round-trip reloads the page, and
		// without this the selector would reset to the config default and read "not connected" even
		// though the deeplink client below hydrates a live session.
		const stored = loadStoredTransport();
		if (stored) {
			this.transport = stored;
		}
		await this.buildClient();
	}

	async setTransport(kind: LinkTransportKind): Promise<void> {
		if (kind === this.transport && this.client) {
			return;
		}
		this.transport = kind;
		saveStoredTransport(kind);
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
			// A deeplink return arrives in the page-URL fragment on (re)load. Record whether THIS tab
			// actually carries one, so "the return never reached this tab" is distinguishable from
			// "it arrived but failed to decrypt/adopt" (the latter still logs Client ready, not
			// Restored session). Permanent diagnostics for the deeplink same-device flow.
			if (this.transport === "deeplink" && typeof window !== "undefined") {
				const hasReturn = /[#&](plv=5|f=)/.test(window.location.hash);
				this.log(
					"info",
					"deeplink-return",
					hasReturn ? "response present in this tab URL" : "no response in this tab URL"
				);
			}
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
				// A deeplink op whose response arrived only after this page reloaded (the original
				// request promise was lost with the old page) is delivered during the build above;
				// surface it now that the session/account are restored so the verdict still lands.
				const delivered = client.takeUnmatchedResponse?.();
				if (delivered) {
					this.surfaceDeliveredResult(delivered);
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

		// Relay and first-time deeplink both establish the channel key out-of-band (relay: the
		// wallet scans the QR; deeplink: the user opens the domain-verified universal pairing link
		// on this device). The session then arrives as an unsolicited SessionEstablished event, so
		// neither calls connect() here - a phantasma:// request sent before the wallet holds the key
		// would be undecryptable and the wallet would surface nothing. Loopback, and a deeplink that
		// already has a live session to resume, fall through to connect() below.
		if (this.transport === "relay" || (this.transport === "deeplink" && !this.account)) {
			runInAction(() => {
				this.status = "pairing";
				this.pairingUri = this.client?.pairingUri;
			});
			this.log(
				"info",
				this.transport === "relay"
					? "Waiting for the wallet to scan the pairing QR"
					: "Open the wallet on this device to pair",
			);
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
		const client = this.client;
		// Clear local state first so the UI reflects the disconnect immediately, independent of any
		// transport round-trip.
		runInAction(() => {
			this.account = undefined;
			this.capabilities = undefined;
			this.status = "idle";
		});
		clearOutstandingOp();
		if (!client) {
			return;
		}
		if (this.transport === "deeplink") {
			// Local-only: do NOT navigate to the wallet just to disconnect. A deeplink
			// pha_disconnect would open the wallet and reload this page, and the persisted session
			// would then resume on the next load ("stuck connected"). Drop it locally instead; the
			// wallet's side lapses on its own session TTL.
			client.forgetSession();
			this.log("result", "disconnect");
		} else {
			try {
				await client.disconnect();
				this.log("result", "disconnect");
			} catch (e) {
				this.log("error", "disconnect", errMsg(e));
			}
		}
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
			{ message },
		);
	}

	sendTransaction(params: SendTransactionParams) {
		return this.run("sendTransaction", () => this.client!.sendTransaction(params), (r) => `hash ${r.hash}`);
	}

	invokeScript(params: InvokeScriptParams) {
		return this.run("invokeScript", () => this.client!.invokeScript(params), (r) => `${r.results.length} result(s)`);
	}

	private async run<T>(
		label: string,
		fn: () => Promise<T>,
		describe: (r: T) => string,
		context?: { message?: string },
	): Promise<T | undefined> {
		if (!this.client) {
			this.log("error", label, "not connected");
			return undefined;
		}
		runInAction(() => {
			this.busyOp = label;
		});
		// Deeplink navigates to the wallet and may reload this page; remember the op so its
		// result can still be surfaced on return even if this promise dies (surfaceDeliveredResult).
		if (this.transport === "deeplink") {
			saveOutstandingOp({ label, message: context?.message });
		}
		this.log("request", label);
		try {
			const result = await fn();
			runInAction(() => {
				this.busyOp = undefined;
				clearOutstandingOp();
				this.log("result", label, describe(result));
			});
			return result;
		} catch (e) {
			runInAction(() => {
				this.busyOp = undefined;
				clearOutstandingOp();
				this.log("error", label, errMsg(e));
			});
			return undefined;
		}
	}

	/** Present a wallet response the SDK delivered with no in-flight request to match it - the
	 * deeplink reload case. Looks up the op persisted before the wallet hop and logs its result
	 * (recomputing the signature verdict for signMessage), then clears it. */
	private surfaceDeliveredResult(response: UnmatchedResponse): void {
		const op = loadOutstandingOp();
		clearOutstandingOp();
		if (!op) {
			this.log("event", "late wallet response", summarize(response.result ?? response.error));
			return;
		}
		if (!response.ok) {
			const msg = (response.error as { message?: string } | undefined)?.message ?? "wallet error";
			this.log("error", op.label, `(after reload) ${msg}`);
			return;
		}
		if (op.label === "signMessage" && op.message) {
			const result = response.result as { signature?: string };
			const verified = verifyV5Signature(
				op.message,
				response.result as Parameters<typeof verifyV5Signature>[1],
				this.account?.address,
			);
			const sig = result?.signature ? ` | ${result.signature.slice(0, 16)}...` : "";
			this.log(
				"result",
				"signMessage",
				`(after reload) verified ${verified === null ? "n/a" : verified ? "VALID" : "INVALID"}${sig}`,
			);
			return;
		}
		this.log("result", op.label, `(after reload) ${summarize(response.result) ?? "ok"}`);
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
