import { makeAutoObservable } from "mobx";
import { EasyConnect } from "phantasma-sdk-ts";
import { createContext } from "react";

export interface IConnectWallet {
	address: string,
}

const STORAGE_KEY = "pha-link-react"

export type LinkTransportMode = "auto" | "injected" | "local-socket"
type LinkTransport = Exclude<LinkTransportMode, "auto">
type FailureClass = "transport" | "wallet"

type SocketHostAttempt = {
	host: string | null,
	success: boolean,
	failure_class: FailureClass | null,
	failure_message: string | null,
	socket_transport: string | null,
	socket_open: boolean,
}

type PersistConfig = {
	platform: string,
	transportMode: LinkTransport,
}

type ConnectOptions = {
	requiredVersion?: number,
	platform?: string,
	transportMode?: LinkTransportMode,
	transportDetectionTimeoutMs?: number,
	connectAttemptTimeoutMs?: number,
}

type ConnectAttemptDiagnostics = {
	configured_transport_mode: LinkTransportMode,
	requested_transport_mode: LinkTransportMode,
	available_transports: LinkTransport[],
	attempted_transports: LinkTransport[],
	selected_transport: LinkTransport | null,
	fallback_used: boolean,
	fallback_from: LinkTransport | null,
	fallback_to: LinkTransport | null,
	selection_reason: string,
	failure_class: FailureClass | null,
	failure_message: string | null,
	platform: string,
	required_version: number,
	injected_transport_detected: boolean,
	local_socket_reachable: boolean | null,
	browser_family: string | null,
	public_origin: boolean | null,
	brave_loopback_permission_suspected: boolean,
	socket_host_attempts: SocketHostAttempt[],
	socket_transport: string | null,
	socket_host: string | null,
	socket_open: boolean,
}

type ConnectOverride = {
	platform?: string,
	transportMode?: LinkTransportMode,
}

type TransportDetection = {
	injected_transport_detected: boolean,
	local_socket_reachable: boolean | null,
	available_transports: LinkTransport[],
}

type TransportDetectionOptions = {
	includeLocalSocketProbe?: boolean,
}

type ConnectAttemptOutcome =
	| {
			success: true,
			conn: EasyConnect,
	  }
	| {
			success: false,
			conn: EasyConnect,
			message: string,
			failureClass: FailureClass,
	  }

type ConnectAttemptResult =
	| {
			success: true,
			conn: EasyConnect,
			hostAttempts: SocketHostAttempt[],
			socketTransport: string | null,
			socketHost: string | null,
			socketOpen: boolean,
	  }
	| {
			success: false,
			conn: EasyConnect,
			message: string,
			failureClass: FailureClass,
			hostAttempts: SocketHostAttempt[],
			socketTransport: string | null,
			socketHost: string | null,
			socketOpen: boolean,
	  }

export type ConnectCtx = {
	restore: () => void | Promise<void>,
	connect: () => void | Promise<void>,
	disconnect: () => void | Promise<void>,
	cancel_connecting?: () => void | Promise<void>,
	is_connecting?: boolean,
	is_disconnecting?: boolean,
	wallet?: IConnectWallet;
}

export function pha_econn_to_conn_wallet(conn: EasyConnect): IConnectWallet | undefined {
	const address = conn.link.account?.address
	return address == null ? undefined : { address }
}

function formatConnectError(res: unknown): string | null {
	if (typeof res === "string" && res.length > 0) {
		return res
	}

	if (res instanceof Error && res.message.length > 0) {
		return res.message
	}

	try {
		const serialized = JSON.stringify(res)
		return typeof serialized === "string" && serialized.length > 0 ? serialized : null
	} catch {
		const fallback = String(res)
		return fallback.length > 0 && fallback !== "undefined" ? fallback : null
	}
}

export class PhaConnectState {
	conn: EasyConnect | null = null;
	err_msg: string | null = null;
	is_connecting: boolean = false;
	connect_options: ConnectOptions;
	selected_transport_mode: LinkTransportMode;
	available_transports: LinkTransport[] = [];
	last_connect_diagnostics: ConnectAttemptDiagnostics | null = null;
	private pending_conn: EasyConnect | null = null;

	constructor(connectOptions: ConnectOptions = {}) {
		this.connect_options = connectOptions
		this.selected_transport_mode = this.normalize_transport_mode(connectOptions.transportMode)
		makeAutoObservable(this);
	}

	private normalize_transport_mode(transportMode: string | null | undefined): LinkTransportMode {
		switch (transportMode) {
			case "auto":
			case "injected":
			case "local-socket":
				return transportMode
			default:
				return "auto"
		}
	}

	private to_concrete_transport(transportMode: string | null | undefined): LinkTransport | null {
		switch (transportMode) {
			case "injected":
			case "local-socket":
				return transportMode
			default:
				return null
		}
	}

	private get transport_detection_timeout_ms(): number {
		return this.connect_options.transportDetectionTimeoutMs ?? 350
	}

	private get connect_attempt_timeout_ms(): number {
		return this.connect_options.connectAttemptTimeoutMs ?? 15000
	}

	private current_origin_hostname(): string | null {
		if (typeof window === "undefined") {
			return null
		}

		try {
			return window.location.hostname
		} catch {
			return null
		}
	}

	private is_public_origin(): boolean | null {
		const hostname = this.current_origin_hostname()
		if (hostname == null) {
			return null
		}

		const localHostnames = new Set([
			"localhost",
			"127.0.0.1",
			"::1",
		])

		return !localHostnames.has(hostname)
	}

	private detect_browser_family(): string | null {
		if (typeof navigator === "undefined") {
			return null
		}

		const userAgent = navigator.userAgent ?? ""
		if ("brave" in navigator || /\bBrave\//i.test(userAgent)) {
			return "brave"
		}
		if (/\bFirefox\//i.test(userAgent)) {
			return "firefox"
		}
		if (/\bEdg\//i.test(userAgent)) {
			return "edge"
		}
		if (/\bChrome\//i.test(userAgent)) {
			return "chrome"
		}
		if (/\bSafari\//i.test(userAgent)) {
			return "safari"
		}

		return null
	}

	private to_sdk_provider_hint(transport: LinkTransport): "ecto" | "poltergeist" {
		return transport === "injected" ? "ecto" : "poltergeist"
	}

	private classify_failure(message: string | null | undefined): FailureClass {
		const normalized = (message ?? "").trim().toLowerCase()
		if (normalized.length === 0) {
			return "transport"
		}

		const transportIndicators = [
			"connection",
			"websocket",
			"socket",
			"timed out",
			"failed to send request",
			"transport",
		]

		return transportIndicators.some((indicator) => normalized.includes(indicator))
			? "transport"
			: "wallet"
	}

	private is_connect_refusal(message: string | null | undefined): boolean {
		const normalized = (message ?? "").trim().toLowerCase()
		if (normalized.length === 0) {
			return false
		}

		const refusalIndicators = [
			"authorization failed",
			"user rejected",
			"transaction cancelled by user",
			"cancelled by user",
			"refused",
			"declined",
		]

		return refusalIndicators.some((indicator) => normalized.includes(indicator))
	}

	private should_suspect_brave_loopback_permission_block(
		transport: LinkTransport,
		attempt: ConnectAttemptResult,
	): boolean {
		if (transport !== "local-socket") {
			return false
		}
		if (attempt.success || attempt.failureClass !== "transport") {
			return false
		}
		if (this.detect_browser_family() !== "brave") {
			return false
		}
		if (this.is_public_origin() !== true) {
			return false
		}
		if (attempt.socketOpen) {
			return false
		}
		if (attempt.hostAttempts.length === 0) {
			return false
		}

		return attempt.hostAttempts.every((hostAttempt) =>
			hostAttempt.success === false &&
			hostAttempt.socket_transport === "websocket" &&
			hostAttempt.socket_open === false,
		)
	}

	private append_brave_loopback_permission_hint(message: string): string {
		return `${message}. Brave may be blocking public-site access to localhost wallet sockets. Allow localhost access for this site in brave://settings/content/localhostAccess or use Browser extension mode.`
	}

	private async probe_local_socket(timeoutMs: number = this.transport_detection_timeout_ms): Promise<boolean> {
		if (typeof window === "undefined" || typeof WebSocket === "undefined") {
			return false
		}

		return await new Promise<boolean>((resolve) => {
			let settled = false
			let socket: WebSocket | null = null

			const finalize = (reachable: boolean) => {
				if (settled) {
					return
				}
				settled = true
				clearTimeout(timer)
				if (socket && socket.readyState === WebSocket.OPEN) {
					socket.close()
				}
				resolve(reachable)
			}

			const timer = window.setTimeout(() => finalize(false), timeoutMs)

			try {
				socket = new WebSocket("ws://localhost:7090/phantasma")
				socket.onopen = () => finalize(true)
				socket.onerror = () => finalize(false)
				socket.onclose = () => finalize(false)
			} catch {
				finalize(false)
			}
		})
	}

	private async detect_available_transports(
		requestedTransportMode: LinkTransportMode = this.selected_transport_mode,
		options: TransportDetectionOptions = {},
	): Promise<TransportDetection> {
		const includeLocalSocketProbe = options.includeLocalSocketProbe ?? true
		const injected_transport_detected =
			typeof window !== "undefined" && "PhantasmaLinkSocket" in window
		// Explicit modes must not poke the other transport endpoint just to populate
		// diagnostics. In particular, `I` must not touch the localhost PGL socket.
		const local_socket_reachable =
			includeLocalSocketProbe &&
			(requestedTransportMode === "auto" || requestedTransportMode === "local-socket")
				? await this.probe_local_socket()
				: null
		const available_transports: LinkTransport[] = []

		if (injected_transport_detected) {
			available_transports.push("injected")
		}

		if (local_socket_reachable) {
			available_transports.push("local-socket")
		}

		this.available_transports = available_transports
		return {
			injected_transport_detected,
			local_socket_reachable,
			available_transports,
		}
	}

	async refresh_available_transports(transportMode: LinkTransportMode = this.selected_transport_mode) {
		return await this.detect_available_transports(transportMode)
	}

	private read_session_config(): PersistConfig | null {
		const raw = localStorage.getItem(STORAGE_KEY)
		if (raw == null) {
			return null
		}

		try {
			const parsed = JSON.parse(raw) as Partial<PersistConfig>
			const transportMode = this.to_concrete_transport(parsed.transportMode)
			if (transportMode == null) {
				return null
			}

			return {
				platform: parsed.platform ?? "phantasma",
				transportMode,
			}
		} catch {
			return null
		}
	}

	private write_session_config(config: PersistConfig) {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
	}

	private resolve_persist_config(conn: EasyConnect): PersistConfig {
		return {
			platform: conn.platform,
			transportMode: conn.link.socketTransport === "injected" ? "injected" : "local-socket",
		}
	}

	persist_config() {
		if (this.conn == null) {
			return
		}

		this.write_session_config(this.resolve_persist_config(this.conn))
	}

	restore_from_persist_storage() {
		if (this.conn != null || this.is_connecting) {
			return
		}

		// Session restore is an auto-only convenience. Explicit transport modes must wait
		// for the next user-initiated connect attempt and must not silently reconnect.
		// They also must not preflight localhost on mount, because background wallet
		// socket probes change protocol behavior before the user has asked to connect.
		if (this.selected_transport_mode !== "auto") {
			return
		}

		const config = this.read_session_config()
		if (config == null) {
			return
		}

		void this.connect({
			platform: config.platform,
			transportMode: "auto",
		})
	}

	clear_session_storage() {
		localStorage.removeItem(STORAGE_KEY)
	}

	get is_connected(): boolean {
		return this.conn != null
	}

	restore() {
		this.restore_from_persist_storage()
	}

	private safe_disconnect(conn: EasyConnect | null, message: string) {
		if (conn == null) {
			return
		}

		try {
			conn.disconnect(message)
		} catch {
			// Best-effort cleanup only.
		}
	}

	abort_pending_connect() {
		if (this.pending_conn == null) {
			return
		}

		const conn = this.pending_conn
		this.pending_conn = null
		this.safe_disconnect(conn, "Abort pending wallet connect")
	}

	private local_socket_hosts(): string[] {
		return ["127.0.0.1:7090", "localhost:7090"]
	}

	private async connect_via_transport_host(
		transport: LinkTransport,
		options: { platform: string, requiredVersion: number, host: string | null },
	): Promise<ConnectAttemptResult> {
		return await new Promise<ConnectAttemptResult>((resolve) => {
			const conn = new EasyConnect([
				String(options.requiredVersion),
				options.platform,
				this.to_sdk_provider_hint(transport),
			])
			if (options.host != null) {
				conn.link.host = options.host
			}
			this.pending_conn = conn
			let settled = false
			const socketHost = conn.link.host ?? options.host ?? null
			const describeTransportFailure = (message: string) =>
				transport === "local-socket" && socketHost != null
					? `${message} (${socketHost})`
					: message
			const buildHostAttempt = (result: ConnectAttemptOutcome): SocketHostAttempt => ({
				host: socketHost,
				success: result.success,
				failure_class: result.success ? null : result.failureClass,
				failure_message: result.success ? null : result.message,
				socket_transport: conn.link.socketTransport ?? null,
				socket_open: conn.link.socketOpen,
			})

			const finalize = (result: ConnectAttemptOutcome) => {
				if (settled) {
					return
				}
				settled = true
				clearTimeout(timer)
				if (this.pending_conn === conn) {
					this.pending_conn = null
				}
				if (!result.success) {
					this.safe_disconnect(conn, "Close failed wallet connect attempt")
				}
				resolve({
					...result,
					hostAttempts: [buildHostAttempt(result)],
					socketTransport: conn.link.socketTransport ?? null,
					socketHost,
					socketOpen: conn.link.socketOpen,
				})
			}

			const timer = setTimeout(() => {
				const transportEstablished = conn.link.socketOpen
				finalize({
					success: false,
					conn,
					message: describeTransportFailure(
						transportEstablished
							? `${transport} transport timed out after connection was established`
							: `${transport} transport connection timed out`,
					),
					failureClass: "transport",
				})
			}, this.connect_attempt_timeout_ms)

			conn.connect(
				() => {
					if (!conn.connected) {
						const message = "Wallet connection callback completed without an active session"
						finalize({
							success: false,
							conn,
							message,
							failureClass: this.classify_failure(message),
						})
						return
					}

					finalize({
						success: true,
						conn,
					})
				},
				(res: any) => {
					const message =
						formatConnectError(res) ??
						(conn.link.socketOpen
							? "Wallet connection failed"
							: `${transport} transport failed during connection`)

					finalize({
						success: false,
						conn,
						message: describeTransportFailure(message),
						failureClass: this.classify_failure(message),
					})
				},
			)
		})
	}

	private async connect_via_transport(
		transport: LinkTransport,
		options: { platform: string, requiredVersion: number },
	): Promise<ConnectAttemptResult> {
		const hosts = transport === "local-socket" ? this.local_socket_hosts() : [null]
		let lastAttempt: ConnectAttemptResult | null = null
		const hostAttempts: SocketHostAttempt[] = []

		for (let index = 0; index < hosts.length; index++) {
			const attempt = await this.connect_via_transport_host(transport, {
				...options,
				host: hosts[index],
			})
			hostAttempts.push(...attempt.hostAttempts)
			lastAttempt = attempt

			if (attempt.success) {
				return {
					...attempt,
					hostAttempts,
				}
			}

			const shouldRetryWithAlternateHost =
				transport === "local-socket" &&
				attempt.failureClass === "transport" &&
				!attempt.socketOpen &&
				index < hosts.length - 1

			if (!shouldRetryWithAlternateHost) {
				return {
					...attempt,
					hostAttempts,
				}
			}
		}

		if (lastAttempt != null) {
			return {
				...lastAttempt,
				hostAttempts,
			}
		}

		throw new Error(`No connection attempts executed for ${transport}`)
	}

	async connect(configOverride: ConnectOverride = {}) {
		const configuredTransportMode = this.normalize_transport_mode(this.connect_options.transportMode)
		const requestedTransportMode = this.normalize_transport_mode(
			configOverride.transportMode ?? this.selected_transport_mode ?? configuredTransportMode,
		)
		const platform = this.connect_options.platform ?? configOverride.platform ?? "phantasma"
		const requiredVersion = this.connect_options.requiredVersion ?? 4

		this.selected_transport_mode = requestedTransportMode
		this.abort_pending_connect()
		if (this.conn != null) {
			const conn = this.conn
			this.conn = null
			this.safe_disconnect(conn, "Replace existing wallet session")
		}
		this.err_msg = null
		this.is_connecting = true

		// Live connect must not create an extra localhost websocket preflight. That
		// preflight races with the real wallet socket and is only safe for explicit
		// diagnostics/UI refreshes.
		const detected = await this.detect_available_transports(
			requestedTransportMode,
			{ includeLocalSocketProbe: false },
		)
		const savedConfig = requestedTransportMode === "auto" ? this.read_session_config() : null
		const diagnostics: ConnectAttemptDiagnostics = {
			configured_transport_mode: configuredTransportMode,
			requested_transport_mode: requestedTransportMode,
			available_transports: detected.available_transports,
			attempted_transports: [],
			selected_transport: null,
			fallback_used: false,
			fallback_from: null,
			fallback_to: null,
			selection_reason: requestedTransportMode === "auto"
				? "auto-connect-without-localhost-preflight"
				: "explicit-transport-mode-without-localhost-preflight",
			failure_class: null,
			failure_message: null,
			platform,
			required_version: requiredVersion,
			injected_transport_detected: detected.injected_transport_detected,
			local_socket_reachable: detected.local_socket_reachable,
			browser_family: this.detect_browser_family(),
			public_origin: this.is_public_origin(),
			brave_loopback_permission_suspected: false,
			socket_host_attempts: [],
			socket_transport: null,
			socket_host: null,
			socket_open: false,
		}

		let transportQueue: LinkTransport[] = []
		if (requestedTransportMode === "auto") {
			const savedTransport = savedConfig?.transportMode ?? null
			if (savedTransport === "local-socket") {
				transportQueue = detected.injected_transport_detected
					? ["local-socket", "injected"]
					: ["local-socket"]
				diagnostics.selection_reason = detected.injected_transport_detected
					? "auto-prefer-saved-local-socket-then-injected-without-preflight"
					: "auto-prefer-saved-local-socket-without-preflight"
			} else if (savedTransport === "injected" && detected.injected_transport_detected) {
				transportQueue = ["injected", "local-socket"]
				diagnostics.selection_reason = "auto-prefer-saved-injected-then-local-socket-without-preflight"
			} else if (detected.injected_transport_detected) {
				transportQueue = ["injected", "local-socket"]
				diagnostics.selection_reason = "auto-prefer-injected-then-local-socket-without-preflight"
			} else {
				transportQueue = ["local-socket"]
				diagnostics.selection_reason = "auto-force-local-socket-without-preflight"
			}
		} else {
			const requestedTransport = this.to_concrete_transport(requestedTransportMode)
			if (requestedTransport != null) {
				if (detected.available_transports.includes(requestedTransport)) {
					transportQueue = [requestedTransport]
				} else if (requestedTransport === "local-socket") {
					transportQueue = ["local-socket"]
					diagnostics.selection_reason = "explicit-local-socket-without-preflight"
				}
			}
		}

		this.last_connect_diagnostics = diagnostics

		if (transportQueue.length === 0) {
			const message =
				requestedTransportMode === "auto"
					? "No supported wallet transports detected. Enable an injected wallet transport or start a local wallet socket."
					: `Requested ${requestedTransportMode} transport is not available.`
			this.err_msg = message
			this.is_connecting = false
			this.clear_session_storage()
			this.last_connect_diagnostics = {
				...diagnostics,
				failure_class: "transport",
				failure_message: message,
				selection_reason: requestedTransportMode === "auto"
					? "no-transport-detected"
					: "explicit-transport-unavailable",
			}
			return
		}

		for (let index = 0; index < transportQueue.length; index++) {
			const transport = transportQueue[index]
			const previousTransport = index > 0 ? transportQueue[index - 1] : null
			const currentDiagnostics: ConnectAttemptDiagnostics = {
				...diagnostics,
				attempted_transports: [...diagnostics.attempted_transports, transport],
				selected_transport: transport,
				fallback_used: index > 0,
				fallback_from: index > 0 ? previousTransport : null,
				fallback_to: index > 0 ? transport : null,
			}
			this.last_connect_diagnostics = currentDiagnostics

			const attempt = await this.connect_via_transport(transport, {
				platform,
				requiredVersion,
			})

			diagnostics.attempted_transports = currentDiagnostics.attempted_transports
			diagnostics.selected_transport = transport
			diagnostics.fallback_used = currentDiagnostics.fallback_used
			diagnostics.fallback_from = currentDiagnostics.fallback_from
			diagnostics.fallback_to = currentDiagnostics.fallback_to
			diagnostics.socket_host_attempts = [
				...diagnostics.socket_host_attempts,
				...attempt.hostAttempts,
			]
			diagnostics.socket_transport = attempt.socketTransport
			diagnostics.socket_host = attempt.socketHost
			diagnostics.socket_open = attempt.socketOpen

			if (attempt.success) {
				this.conn = attempt.conn
				this.is_connecting = false
				this.last_connect_diagnostics = {
					...diagnostics,
					failure_class: null,
					failure_message: null,
				}
				this.persist_config()
				return
			}

			diagnostics.failure_class = attempt.failureClass
			diagnostics.failure_message = attempt.message
			diagnostics.brave_loopback_permission_suspected =
				this.should_suspect_brave_loopback_permission_block(transport, attempt)

			if (diagnostics.brave_loopback_permission_suspected) {
				diagnostics.failure_message = this.append_brave_loopback_permission_hint(attempt.message)
			}
			this.last_connect_diagnostics = { ...diagnostics }

			const shouldFallback =
				requestedTransportMode === "auto" &&
				(
					attempt.failureClass === "transport" ||
					this.is_connect_refusal(attempt.message)
				) &&
				index < transportQueue.length - 1

			if (shouldFallback) {
				continue
			}

			this.err_msg = diagnostics.failure_message
			this.is_connecting = false
			this.clear_session_storage()
			return
		}

		this.err_msg = diagnostics.failure_message ?? "Wallet connection failed"
		this.is_connecting = false
		this.clear_session_storage()
	}

	connect_with_transport_mode(transportMode: LinkTransportMode) {
		this.selected_transport_mode = this.normalize_transport_mode(transportMode)
		return this.connect({ transportMode: this.selected_transport_mode })
	}

	set_transport_mode(transportMode: LinkTransportMode) {
		if (this.is_connecting) {
			this.abort_pending_connect()
			this.is_connecting = false
		}
		this.selected_transport_mode = this.normalize_transport_mode(transportMode)
	}

	disconnect() {
		this.abort_pending_connect()
		if (this.conn != null) {
			const conn = this.conn
			this.conn = null
			this.safe_disconnect(conn, "Graceful Disconect")
		}
		this.err_msg = null
		this.is_connecting = false
		this.clear_session_storage()
	}
}

export const PhaConnectCtx = createContext<PhaConnectState>(new PhaConnectState())

export { PhaAccountWidgetV1, AccountWidgetV1 } from "./components/AccountWidgetV1"
