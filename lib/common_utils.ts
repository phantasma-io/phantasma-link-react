// Small shared UI/util helpers for the Phantasma Link React bindings.

/** Copy text to the clipboard (no-op when the Clipboard API is unavailable, e.g. SSR). */
export function clip_copy(content: string): void {
	void navigator?.clipboard?.writeText(content);
}

/** Extract a human-readable message from an unknown thrown value. Shared so the store and its
 * consumers report errors identically. */
export function errMsg(e: unknown): string {
	if (e && typeof e === "object" && "message" in e) {
		return String((e as { message: unknown }).message);
	}
	return String(e);
}
