// Signature verification for Phantasma Link v5 signMessage results. Kept as a standalone, pure
// module so it can be unit-tested and reused by consumers without pulling in the whole store.

import {
	buildSignMessagePayload,
	utf8ToBytes,
	base64ToBytes,
	type SignMessageResult,
} from "phantasma-sdk-ts/link/v5";
import { verifyData, bytesToHex } from "phantasma-sdk-ts/public";

/** Verify a v5 signMessage result against the signer's address.
 * Returns true/false for a checkable signature, or null when it cannot be checked (no address,
 * or malformed inputs). The wallet signs `DOMAIN_TAG || random || message` (spec §8) with a raw
 * detached Ed25519 signature; `verifyData` wants the Phantasma envelope `01<len-byte><sig-hex>`. */
export function verifyV5Signature(
	message: string,
	result: SignMessageResult,
	address?: string,
): boolean | null {
	if (!address) {
		return null;
	}
	try {
		const payload = buildSignMessagePayload(utf8ToBytes(message), base64ToBytes(result.random));
		const sig = base64ToBytes(result.signature);
		const phaSig = "01" + sig.length.toString(16).padStart(2, "0") + bytesToHex(sig);
		return verifyData(bytesToHex(payload), phaSig, address);
	} catch {
		return null;
	}
}
