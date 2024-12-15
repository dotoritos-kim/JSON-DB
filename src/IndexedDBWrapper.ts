export class IndexedDBWrapper<T extends object> {
	private dbName: string;
	private storeName: string;
	private db: IDBDatabase | null = null;

	constructor(dbName: string, storeName: string) {
		this.dbName = dbName;
		this.storeName = storeName;
	}

	public async open(): Promise<void> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(this.dbName, 1);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(this.storeName)) {
					db.createObjectStore(this.storeName, { keyPath: "key" });
				}
			};
			request.onsuccess = () => {
				this.db = request.result;
				resolve();
			};
			request.onerror = () => {
				reject(request.error);
			};
		});
	}

	public async getValue(): Promise<T | null> {
		if (!this.db) throw new Error("DB not opened");
		return new Promise((resolve, reject) => {
			const tx = this.db!.transaction(this.storeName, "readonly");
			const store = tx.objectStore(this.storeName);
			const request = store.get("data");
			request.onsuccess = () => {
				const result = request.result;
				resolve(result ? (result.value as T) : null);
			};
			request.onerror = () => {
				reject(request.error);
			};
		});
	}

	public async setValue(value: T): Promise<void> {
		if (!this.db) throw new Error("DB not opened");
		return new Promise((resolve, reject) => {
			const tx = this.db!.transaction(this.storeName, "readwrite");
			const store = tx.objectStore(this.storeName);
			const request = store.put({ key: "data", value: value });
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}
}

function getValueAtPath(obj: any, path: (string | number)[]): any {
	let current = obj;
	for (const p of path) {
		if (current == null) return undefined;
		current = current[p];
	}
	return current;
}

function setValueAtPath(obj: any, path: (string | number)[], value: any): void {
	let current = obj;
	const lastKey = path[path.length - 1];
	const parentPath = path.slice(0, -1);

	for (const p of parentPath) {
		if (current[p] == null) {
			current[p] = typeof p === "number" ? [] : {};
		}
		current = current[p];
	}
	current[lastKey] = value;
}

function deleteValueAtPath(obj: any, path: (string | number)[]): void {
	let current = obj;
	const lastKey = path[path.length - 1];
	const parentPath = path.slice(0, -1);

	for (const p of parentPath) {
		if (current[p] == null) {
			return;
		}
		current = current[p];
	}
	delete current[lastKey];
}

export function createDBBackedProxy<T extends object>(
	wrapper: IndexedDBWrapper<T>,
	createDefaultObject: () => T,
	path: (string | number)[] = []
): T & { toJSON: () => Promise<any> } {
	const handler: ProxyHandler<object> = {
		get(target, prop, receiver) {
			if (prop === "toJSON") {
				return async () => {
					const fullObj = await wrapper.getValue();
					if (!fullObj) return null;
					return getValueAtPath(fullObj, path);
				};
			}

			const propKey = typeof prop === "symbol" ? prop.toString() : prop;

			return (async () => {
				const fullObj = await wrapper.getValue();
				if (!fullObj) return undefined;
				const value = getValueAtPath(fullObj, path.concat(propKey));
				if (value && typeof value === "object") {
					return createDBBackedProxy(
						wrapper,
						createDefaultObject,
						path.concat(propKey)
					);
				}
				return value;
			})();
		},
		set(target, prop, value, receiver) {
			const propKey = typeof prop === "symbol" ? prop.toString() : prop;
			(async () => {
				const maybeFullObj = await wrapper.getValue(); // T | null
				let fullObj: T;
				if (maybeFullObj === null) {
					fullObj = createDefaultObject(); // null일 경우 기본 객체 생성 (T)
				} else {
					fullObj = maybeFullObj; // T
				}
				setValueAtPath(fullObj, path.concat(propKey), value);
				await wrapper.setValue(fullObj); // fullObj: T
			})();
			return true;
		},
		deleteProperty(target, prop) {
			const propKey = typeof prop === "symbol" ? prop.toString() : prop;
			(async () => {
				const maybeFullObj = await wrapper.getValue(); // T | null
				if (maybeFullObj !== null) {
					const fullObj: T = maybeFullObj; // fullObj는 T로 확정
					deleteValueAtPath(fullObj, path.concat(propKey));
					await wrapper.setValue(fullObj);
				}
			})();
			return true;
		},
	};

	return new Proxy({}, handler) as T & {
		toJSON: () => Promise<any>;
	};
}
