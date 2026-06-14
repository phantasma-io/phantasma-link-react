// React context + lifecycle for a PhantasmaLinkStore. The provider owns one store, builds its
// client on mount (restoring any persisted session) and disposes it on unmount.

"use client";

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { PhantasmaLinkStore, type PhantasmaLinkConfig } from "./store";

const PhantasmaLinkContext = createContext<PhantasmaLinkStore | null>(null);

export interface PhantasmaLinkProviderProps {
	config: PhantasmaLinkConfig;
	children: ReactNode;
}

export function PhantasmaLinkProvider({ config, children }: PhantasmaLinkProviderProps) {
	// Rebuild the store only when an identity-defining field changes, not on every render
	// (a freshly-spread `config` object would otherwise recreate it each time).
	const store = useMemo(
		() => new PhantasmaLinkStore(config),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[config.dapp.name, config.dapp.url, config.relayUrl, config.host],
	);

	useEffect(() => {
		void store.init();
		return () => store.dispose();
	}, [store]);

	return <PhantasmaLinkContext.Provider value={store}>{children}</PhantasmaLinkContext.Provider>;
}

/** Access the store created by the nearest {@link PhantasmaLinkProvider}. Components that read
 * observable fields off it should be wrapped in mobx-react `observer`. */
export function usePhantasmaLink(): PhantasmaLinkStore {
	const store = useContext(PhantasmaLinkContext);
	if (!store) {
		throw new Error("usePhantasmaLink must be used within a <PhantasmaLinkProvider>");
	}
	return store;
}
