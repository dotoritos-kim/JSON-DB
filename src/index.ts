import { createDBBackedProxy, IndexedDBWrapper } from "./IndexedDBWrapper";
import { useIndexedDBState } from "./react/ReactIndexedDBWrapper";

export class IndexedJSON {
	dbName: string;
	storeName: string;
	constructor(dbName: string, storeName: string) {
		this.dbName = dbName;
		this.storeName = storeName;
	}

	async create<T extends object>(
		createDefaultObject: () => T
	): Promise<T & { toJSON: () => Promise<any> }> {
		const wrapper = new IndexedDBWrapper<T>(this.dbName, this.storeName);
		await wrapper.open();

		let value: T | null = await wrapper.getValue();
		if (!value) {
			value = createDefaultObject();
			await wrapper.setValue(value);
		}

		return createDBBackedProxy(wrapper, createDefaultObject, []);
	}

	useIndexedDBState() {
		return useIndexedDBState;
	}
}
