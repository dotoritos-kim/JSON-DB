import React, { useEffect, useState, useCallback, useMemo } from "react";
import { IndexedDBWrapper } from "../IndexedDBWrapper";

type UseIndexedDBStateReturn<T> = [
	T,
	boolean,
	React.Dispatch<React.SetStateAction<T>>,
	() => Promise<void>
];

export function useIndexedDBState<T extends object>(
	dbName: string,
	storeName: string,
	createDefaultObject: () => T,
	manualFlush: boolean = false
): UseIndexedDBStateReturn<T> {
	const [data, setData] = useState<T>(() => createDefaultObject());
	const [loaded, setLoaded] = useState(false);

	const wrapper = useMemo(
		() => new IndexedDBWrapper<T>(dbName, storeName),
		[dbName, storeName]
	);

	useEffect(() => {
		(async () => {
			await wrapper.open();
			const val = await wrapper.getValue();
			if (val !== null) {
				setData(val);
			}
			setLoaded(true);
		})();
	}, [wrapper]);

	const flush = useCallback(async () => {
		await wrapper.setValue(data);
	}, [data, wrapper]);

	useEffect(() => {
		if (!manualFlush && loaded) {
			(async () => {
				await wrapper.setValue(data);
			})();
		}
	}, [data, manualFlush, loaded, wrapper]);

	return [data, loaded, setData, flush];
}
