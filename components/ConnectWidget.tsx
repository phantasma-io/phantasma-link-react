// Drop-in connect button for the Phantasma Link v5 session. Shows "Connect wallet" until a
// session is live (opening the pairing QR/link), then an account dropdown with copy/disconnect.
// Reads the store via usePhantasmaLink(); wrapped in `observer` so it tracks status/account.

"use client";

import { useState } from "react";
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
import { clip_copy, str_cut } from "../lib/common_utils";

export const ConnectWidget = observer(function ConnectWidget() {
	const store = usePhantasmaLink();
	const [showPairing, setShowPairing] = useState(false);

	if (store.connected && store.account) {
		const address = store.account.address;
		return (
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="outline" className="gap-2">
						<Wallet className="size-4" />
						{str_cut(address)}
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
	const cancel = () => {
		setShowPairing(false);
		void store.cancel();
	};
	return (
		<>
			{busy ? (
				<Button variant="outline" className="gap-2" onClick={cancel}>
					<X className="size-4" />
					Cancel
				</Button>
			) : (
				<Button
					variant="outline"
					className="gap-2"
					disabled={!store.client}
					onClick={() => {
						void store.connect();
						setShowPairing(true);
					}}
				>
					<Wallet className="size-4" />
					Connect wallet
				</Button>
			)}
			{showPairing && store.pairingUri ? (
				<PairingModal uri={store.pairingUri} transport={store.transport} onClose={cancel} />
			) : null}
		</>
	);
});
