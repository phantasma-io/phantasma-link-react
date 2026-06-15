// Drop-in connect button for the Phantasma Link v5 session. Shows "Connect wallet" until a
// session is live (opening the pairing QR/link), then an account dropdown with copy/disconnect.
// Reads the store via usePhantasmaLink(); wrapped in `observer` so it tracks status/account.

"use client";

import { observer } from "mobx-react";
import { Wallet, LogOut, Copy, X } from "lucide-react";
import { Button } from "./ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { usePhantasmaLink } from "../lib/provider";
import { PairingModal } from "./PairingModal";
import { clip_copy } from "../lib/common_utils";

export const ConnectWidget = observer(function ConnectWidget() {
	const store = usePhantasmaLink();

	if (store.connected && store.account) {
		const address = store.account.address;
		return (
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="outline" className="gap-2 font-mono text-xs">
						<Wallet className="size-4 shrink-0" />
						{address}
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onClick={() => clip_copy(address)}>
						<Copy className="size-4" />
						Copy address
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem variant="destructive" onClick={() => void store.disconnect()}>
						<LogOut className="size-4" />
						Disconnect
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		);
	}

	const busy = store.status === "pairing" || store.status === "connecting";
	return (
		<>
			{busy ? (
				<Button variant="outline" className="gap-2" onClick={() => void store.cancel()}>
					<X className="size-4" />
					Cancel
				</Button>
			) : (
				<Button
					variant="outline"
					className="gap-2"
					disabled={!store.client}
					onClick={() => void store.connect()}
				>
					<Wallet className="size-4" />
					Connect wallet
				</Button>
			)}
			{/* The pairing QR belongs to the relay transport only - it is the single transport that
			    enters the "pairing" state (waiting for the wallet to scan). Loopback and deeplink
			    connect directly via connect(), so they must never render the QR. Gating on the
			    store's own status (not a local flag) keeps a stale URI from leaking a QR after a
			    transport switch. */}
			{store.status === "pairing" && store.pairingUri ? (
				<PairingModal
					uri={store.pairingUri}
					transport={store.transport}
					onClose={() => void store.cancel()}
				/>
			) : null}
		</>
	);
});
