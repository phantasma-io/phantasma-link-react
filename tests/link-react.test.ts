// Unit tests for the pure logic in @phantasma/link-react: the v5 signMessage verification helper
// and the address-truncation utility. Run with `npm test` (vitest).

import { describe, it, expect } from "vitest";
import { verifyV5Signature } from "../lib/verify";
import {
	buildSignMessagePayload,
	utf8ToBytes,
	bytesToBase64,
	base64ToBytes,
	type SignMessageResult,
} from "phantasma-sdk-ts/link/v5";
import {
	generateNewWif,
	getPrivateKeyFromWif,
	getAddressFromWif,
	signData,
	bytesToHex,
	hexToBytes,
} from "phantasma-sdk-ts/public";

// Build a genuine v5 signMessage result for `message` from a fresh key, exactly as the wallet
// would: sign `DOMAIN_TAG || random || message` with a raw detached Ed25519 signature. signData
// returns the Phantasma envelope `01<len><sig>`, so we strip the 4-char prefix to recover the raw
// signature bytes the wallet hands back in `result.signature`.
function signV5(message: string, wif: string): { result: SignMessageResult; address: string } {
	const privHex = getPrivateKeyFromWif(wif);
	const address = getAddressFromWif(wif);
	const random = new Uint8Array(32);
	for (let i = 0; i < random.length; i++) random[i] = i; // deterministic random for the test
	const payloadHex = bytesToHex(buildSignMessagePayload(utf8ToBytes(message), random));
	const rawSig = hexToBytes(signData(payloadHex, privHex).substring(4));
	return {
		result: { signature: bytesToBase64(rawSig), random: bytesToBase64(random) },
		address,
	};
}

describe("verifyV5Signature", () => {
	const wif = generateNewWif();
	const message = "Hello from the Phantasma Link Playground";

	it("returns true for a signature produced by the address's key", () => {
		const { result, address } = signV5(message, wif);
		expect(verifyV5Signature(message, result, address)).toBe(true);
	});

	it("returns false when the verified message differs from the signed one", () => {
		const { result, address } = signV5(message, wif);
		expect(verifyV5Signature("a different message", result, address)).toBe(false);
	});

	it("returns false when the signature bytes are tampered", () => {
		const { result, address } = signV5(message, wif);
		const sig = base64ToBytes(result.signature);
		sig[0] ^= 0xff;
		const tampered: SignMessageResult = { ...result, signature: bytesToBase64(sig) };
		expect(verifyV5Signature(message, tampered, address)).toBe(false);
	});

	it("returns null (uncheckable) when no address is supplied", () => {
		const { result } = signV5(message, wif);
		expect(verifyV5Signature(message, result, undefined)).toBe(null);
	});
});
