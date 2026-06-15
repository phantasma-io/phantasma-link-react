// The pairing surface, branched by transport: relay renders the v5 pairing URI as a QR for a
// separate phone to scan; deeplink (same device) shows a button that opens the wallet on THIS
// device - no QR, there is nothing to scan. The URI carries the channel key in its fragment, so
// it is only ever rendered locally - never sent anywhere.

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
					{transport === "relay" ? (
						<>
							<div className="rounded-xl bg-white p-3">
								<QRCodeSVG value={uri} size={224} marginSize={1} level="M" />
							</div>
							<p className="text-center text-sm text-muted-foreground">
								Scan this code with the Poltergeist wallet on your phone, then approve the pairing.
							</p>
						</>
					) : (
						<>
							<p className="text-center text-sm text-muted-foreground">
								Open the Poltergeist wallet on this device and approve the pairing.
							</p>
							<Button
								className="w-full"
								onClick={() => {
									window.location.href = uri;
								}}
							>
								Open wallet on this device
							</Button>
						</>
					)}
					<Button variant="outline" className="w-full" onClick={() => clip_copy(uri)}>
						Copy pairing link
					</Button>
				</div>
			</div>
		</div>
	);
}
