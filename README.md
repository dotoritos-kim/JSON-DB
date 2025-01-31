# Json-VR-Cache

[README-EN](https://github.com/dotoritos-kim/Json-VR-Cache/blob/main/README.md)

[README-KR](https://github.com/dotoritos-kim/Json-VR-Cache/blob/main/README-KR.md)

## Introduction

**Json-VR-Cache** is a project that leverages WebGPU to efficiently store large-scale JSON data in GPU memory, keeping only metadata in CPU memory for fast operations and sorting. By using classes like `JsonGpuStore` and `VramDataBase`, you can manage data in JSON, TypedArray, or ArrayBuffer formats, and perform GPU-based sorting.

---

## Key Features

### 1) `JsonGpuStore`

-   **Proxy-Based JSON Management**: Wraps JSON data in a Proxy; when you modify the data, changes are automatically reflected in the GPU DB (`VramDataBase`).
-   **Automatic WebGPU Device Acquisition**: Internally requests a WebGPU device using `getWebGpuDevice()`.
-   **Initialization**: Creates a store with `dataType: "JSON"` and automatically saves the initial JSON object upon instantiation.
-   **Real-Time Updates**: Whenever you change the Proxy object, a `put` operation is triggered to update the data in GPU memory.

---

### 2) `VramDataBase`

-   **Multiple Data Types**: Supports JSON, TypedArray, and ArrayBuffer.
-   **GPU Buffer Usage**: Stores the main data in GPU buffers, while only keeping metadata in CPU memory for fast access.
-   **Object Stores**: Use `createObjectStore` or `deleteObjectStore` to create or remove stores, and `listObjectStores` to view them.
-   **CRUD Capabilities**: Manipulate data with methods such as `add`, `put`, `get`, `getMultiple`, and `delete`.
-   **Batch/Delayed Writes**: Collect write requests in `pendingWrites` and flush them to the GPU at once (triggered by batch size or a timer).
-   **JSON Sorting**: When a JSON store has a `sortDefinition`, a `<storeName>-offsets` store is automatically created to store numeric offsets for GPU-based sorting.
-   **Pagination & Wildcards**: `getMultiple` provides pagination (skip/take) and supports SQL-style wildcards like `%`, `_`, and `[]`.
-   **Cursor**: Iterate through records with `openCursor`, specifying a range and direction (`next`, `prev`).
-   **GPU Sorting**: Utilizes a bitonic sort algorithm for very fast sorting on the GPU.

---

## Quick Start

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/<username>/Json-VR-Cache.git
cd Json-VR-Cache
npm install
```

### 2. Build/Compile

```bash
npm run build
```

### 3. Example Code

Below is an example in TypeScript; JavaScript usage is similar.

```ts
const initialData = { count: 0, nested: { value: 10 } };
const jsonGpu = new JsonGpuStore("HighLevelStore", "myKey", initialData);

await jsonGPU.init({
	dataType: "JSON",
	bufferSize: 1024 * 1024,
	totalRows: 1,
});

// Proxy object
const proxyData = jsonGpu.getProxy();

// Modifying the proxy automatically reflects updates in the GPU DB
proxyData.count = 999;
proxyData.nested.value = 888;
```

---

Below is an example using TypeScript + React:

```ts
import { useState, useEffect } from "react";
import { IDBOptions } from "./types/StoreMetadata";
import { VramDataBase } from "./VramDataBase";
import { getWebGpuDevice } from "./JsonGpuStore";

export function useJsonDB(storeName: string, options?: IDBOptions) {
	const [jsonDB, setJsonDB] = useState<VramDataBase | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<Error | null>(null);

	useEffect(() => {
		let isMounted = true;

		async function initializeDB() {
			try {
				setLoading(true);
				setError(null);
				setJsonDB(null);

				const device = await getWebGpuDevice();
				const db = new VramDataBase(device);
				db.createObjectStore(
					storeName,
					options ?? {
						dataType: "JSON",
						bufferSize: 256 * 1024 * 1024,
						totalRows: 1,
					}
				);
				await db.initializeManager();

				if (isMounted) {
					setJsonDB(db);
				}
			} catch (err) {
				if (isMounted) {
					setError(err as Error);
				}
			} finally {
				if (isMounted) {
					setLoading(false);
				}
			}
		}

		initializeDB();

		return () => {
			isMounted = false;
		};
	}, [storeName, options]);

	return { jsonDB, loading, error };
}
```

## Directory Structure

```plaintext
Json-VR-Cache/
├── VramDataBase.ts       # Core WebGPU-based database logic
├── JsonGpuStore.ts       # Proxy-based JSON management
├── types
│   └── StoreMetadata.ts  # Type definitions & interfaces
├── utils.ts              # Utility functions
├── README.md             # This README
└── ...
```

---

## Implementation Details

-   **Batch Writes**: Gathers write operations in a `pendingWrites` queue and flushes them once the batch size is reached or the timer expires.
-   **Sort Definitions**: If a JSON store has `sortDefinition`, a `<storeName>-offsets` store is created to manage numeric field offsets for GPU-based sorting.
-   **Bitonic Sort**: Uses a WGSL-based compute shader to quickly sort `(rowId + fieldValue)` tuples.
-   **Memory Constraints**: GPU sorting may stop if the data exceeds the `maxStorageBufferBindingSize` limit.
-   **Wildcards**: SQL-style LIKE syntax (`%`, `_`, `[]`) is converted to JavaScript regex and supported for key matching.

---

## Contributing

Bug reports, feature suggestions, and pull requests are welcome at any time.

---

## License

**[GNU General Public License (GPLv2)](LICENSE)**  
For details, refer to the `LICENSE` file.
