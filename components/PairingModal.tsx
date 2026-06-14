// The pairing surface: renders the v5 pairing URI as a QR (for a phone to scan) plus, on the
// same-device deeplink path, a button that opens the wallet on this device. The URI carries the
// channel key in its fragment, so it is only ever rendered locally - never sent anywhere.

"use client";

import { QRCodeSVG } from "qrcode.react";
import { X } from "lucide-react";
import { Button } from "./ui/button";
import { clip_copy } from "../lib/common_utils";
import type { LinkTransportKind } from "../lib/store";

export interface PairingModalProps {
	uri: string;
	transport: LinkTransportKind;
	onClose: () => void;
}

export function PairingModal({ uri, transport, onClose }: PairingModalProps) {
	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
			onClick={onClose}
			role="presentation"
		>
			<div
				className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-xl"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="mb-4 flex items-center justify-between">
					<h2 className="text-lg font-semibold">
						{transport === "relay" ? "Scan to connect" : "Open your wallet"}
					</h2>
					<button
						type="button"
						className="text-muted-foreground transition-colors hover:text-foreground"
						onClick={onClose}
						aria-label="Close"
					>
						<X className="size-5" />
					</button>
				</div>

				<div className="flex flex-col items-center gap-4">
					<div className="rounded-xl bg-white p-3">
						<QRCodeSVG value={uri} size={224} marginSize={1} level="M" />
					</div>
					<p className="text-center text-sm text-muted-foreground">
						{transport === "relay"
							? "Scan this code with the Poltergeist wallet on your phone, then approve the pairing."
							: "Scan with your phone wallet, or open the wallet on this device."}
					</p>
					{transport === "deeplink" ? (
						<Button
							className="w-full"
							onClick={() => {
								window.location.href = uri;
							}}
						>
							Open wallet on this device
						</Button>
					) : null}
					<Button variant="outline" className="w-full" onClick={() => clip_copy(uri)}>
						Copy pairing link
					</Button>
				</div>
			</div>
		</div>
	);
}
