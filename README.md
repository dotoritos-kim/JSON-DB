# Json-VR-Cache

![Json-VR-Cache](favicon.ico)

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
const jsonGpu = new JsonGpuStore("HighLevelStore", "myKey", initialData, {
	debounce: false,
});

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
				db.StoreManager.createObjectStore(
					storeName,
					options ?? {
						dataType: "JSON",
						bufferSize: 256 * 1024 * 1024,
						totalRows: 1,
					}
				);

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
├── vramDataBase.ts       # Core WebGPU-based database logic
├── JsonGpuStore.ts       # Proxy-based JSON management
├── types
│   └── StoreMetadata.ts  # Type definitions & interfaces
├── utils.ts              # Utility functions
├── README.md             # This README
└── ...
```

---

## TEST

### Check for WebGPU Support in Your Browser

```typescript
const device = await getWebGpuDevice();

if (!device) {
	console.error("Failed to get GPU adapter.");
	return;
}
```

### Test the Store for All Data Types

```typescript
// Create an instance of VramDataBase
const device = await getWebGpuDevice();
const db = new VramDataBase(device);
```

```typescript
// [Step] Create a store: jsonStore
vramDataBase.StoreManager.createObjectStore("jsonStore", {
	dataType: "JSON",
	bufferSize: 1048576,
	totalRows: 50,
});

// [Step] Add data (fails if the key already exists)
const dataToAdd = { greeting: "Hello JSON Store!", time: 1738402167838 };
await vramDataBase.StoreManager.add("jsonStore", "JsonKey", dataToAdd);

// [Step] Retrieve data
const retrievedAdd = await vramDataBase.StoreManager.get(
	"jsonStore",
	"JsonKey"
);
console.log("Retrieved after add:", retrievedAdd);

// [Step] Update data (overwrite existing key)
const updatedData = { updatedField: "newValue", time: 1738402173462 };
await vramDataBase.StoreManager.put("jsonStore", "JsonKey", updatedData);

// [Step] Use openCursor to view all key/value pairs
for await (const record of vramDataBase.StoreManager.openCursor("jsonStore")) {
	console.log(record.key, record.value);
}

// [Step] Delete a single record by key
await vramDataBase.StoreManager.delete("jsonStore", "JsonKey");

// [Step] Delete the store
vramDataBase.StoreManager.deleteObjectStore("jsonStore");

// [Step] Create a store: float32Store
vramDataBase.StoreManager.createObjectStore("float32Store", {
	dataType: "TypedArray",
	typedArrayType: "Float32Array",
	bufferSize: 1048576,
	totalRows: 50,
});

// [Step] Add data (fails if the key already exists)
const dataToAddFloat32 = new Float32Array([
	1.1100000143051147, 2.2200000286102295, 3.3299999237060547,
]);
await vramDataBase.StoreManager.add(
	"float32Store",
	"myFloat32Key",
	dataToAddFloat32
);

// [Step] Retrieve data
const retrievedAddFloat32 = await vramDataBase.StoreManager.get(
	"float32Store",
	"myFloat32Key"
);
console.log("Retrieved after add:", retrievedAddFloat32);

// [Step] Update data (overwrite existing key)
const updatedDataFloat32 = new Float32Array([9, 8, 7]);
await vramDataBase.StoreManager.put(
	"float32Store",
	"myFloat32Key",
	updatedDataFloat32
);

// [Step] Use openCursor to view all key/value pairs
for await (const record of vramDataBase.StoreManager.openCursor(
	"float32Store"
)) {
	console.log(record.key, record.value);
}

// [Step] Delete a single record by key
await vramDataBase.StoreManager.delete("float32Store", "myFloat32Key");

// [Step] Delete the store
vramDataBase.StoreManager.deleteObjectStore("float32Store");

// [Step] Create a store: float64Store
vramDataBase.StoreManager.createObjectStore("float64Store", {
	dataType: "TypedArray",
	typedArrayType: "Float64Array",
	bufferSize: 1048576,
	totalRows: 50,
});

// [Step] Add data (fails if the key already exists)
const dataToAddFloat64 = new Float64Array([10.01, 20.02, 30.03]);
await vramDataBase.StoreManager.add(
	"float64Store",
	"Float64Key",
	dataToAddFloat64
);

// [Step] Retrieve data
const retrievedAddFloat64 = await vramDataBase.StoreManager.get(
	"float64Store",
	"Float64Key"
);
console.log("Retrieved after add:", retrievedAddFloat64);

// [Step] Update data (overwrite existing key)
const updatedDataFloat64 = new Float64Array([9, 8, 7]);
await vramDataBase.StoreManager.put(
	"float64Store",
	"Float64Key",
	updatedDataFloat64
);

// [Step] Use openCursor to view all key/value pairs
for await (const record of vramDataBase.StoreManager.openCursor(
	"float64Store"
)) {
	console.log(record.key, record.value);
}

// [Step] Delete a single record by key
await vramDataBase.StoreManager.delete("float64Store", "Float64Key");

// [Step] Delete the store
vramDataBase.StoreManager.deleteObjectStore("float64Store");

// [Step] Create a store: int32Store
vramDataBase.StoreManager.createObjectStore("int32Store", {
	dataType: "TypedArray",
	typedArrayType: "Int32Array",
	bufferSize: 2048000,
	totalRows: 100,
});

// [Step] Add data (fails if the key already exists)
const dataToAddInt32 = new Int32Array([-1, 0, 99999]);
await vramDataBase.StoreManager.add("int32Store", "Int32Key", dataToAddInt32);

// [Step] Retrieve data
const retrievedAddInt32 = await vramDataBase.StoreManager.get(
	"int32Store",
	"Int32Key"
);
console.log("Retrieved after add:", retrievedAddInt32);

// [Step] Update data (overwrite existing key)
const updatedDataInt32 = new Int32Array([9, 8, 7]);
await vramDataBase.StoreManager.put("int32Store", "Int32Key", updatedDataInt32);

// [Step] Use openCursor to view all key/value pairs
for await (const record of vramDataBase.StoreManager.openCursor("int32Store")) {
	console.log(record.key, record.value);
}

// [Step] Delete a single record by key
await vramDataBase.StoreManager.delete("int32Store", "Int32Key");

// [Step] Delete the store
vramDataBase.StoreManager.deleteObjectStore("int32Store");

// [Step] Create a store: uint32Store
vramDataBase.StoreManager.createObjectStore("uint32Store", {
	dataType: "TypedArray",
	typedArrayType: "Uint32Array",
	bufferSize: 1048576,
	totalRows: 50,
});

// [Step] Add data (fails if the key already exists)
const dataToAddUint32 = new Uint32Array([1, 2, 3]);
await vramDataBase.StoreManager.add(
	"uint32Store",
	"Uint32Key",
	dataToAddUint32
);

// [Step] Retrieve data
const retrievedAddUint32 = await vramDataBase.StoreManager.get(
	"uint32Store",
	"Uint32Key"
);
console.log("Retrieved after add:", retrievedAddUint32);

// [Step] Update data (overwrite existing key)
const updatedDataUint32 = new Uint32Array([1, 2, 3]);
await vramDataBase.StoreManager.put(
	"uint32Store",
	"Uint32Key",
	updatedDataUint32
);

// [Step] Use openCursor to view all key/value pairs
for await (const record of vramDataBase.StoreManager.openCursor(
	"uint32Store"
)) {
	console.log(record.key, record.value);
}

// [Step] Delete a single record by key
await vramDataBase.StoreManager.delete("uint32Store", "Uint32Key");

// [Step] Delete the store
vramDataBase.StoreManager.deleteObjectStore("uint32Store");

// [Step] Create a store: uint8Store
vramDataBase.StoreManager.createObjectStore("uint8Store", {
	dataType: "TypedArray",
	typedArrayType: "Uint8Array",
	bufferSize: 2048000,
	totalRows: 100,
});

// [Step] Add data (fails if the key already exists)
const dataToAddUint8 = new Uint8Array([0, 255, 128, 64]);
await vramDataBase.StoreManager.add("uint8Store", "Uint8Key", dataToAddUint8);

// [Step] Retrieve data
const retrievedAddUint8 = await vramDataBase.StoreManager.get(
	"uint8Store",
	"Uint8Key"
);
console.log("Retrieved after add:", retrievedAddUint8);

// [Step] Update data (overwrite existing key)
const updatedDataUint8 = new Uint8Array([9, 8, 7]);
await vramDataBase.StoreManager.put("uint8Store", "Uint8Key", updatedDataUint8);

// [Step] Use openCursor to view all key/value pairs
for await (const record of vramDataBase.StoreManager.openCursor("uint8Store")) {
	console.log(record.key, record.value);
}

// [Step] Delete a single record by key
await vramDataBase.StoreManager.delete("uint8Store", "Uint8Key");

// [Step] Delete the store
vramDataBase.StoreManager.deleteObjectStore("uint8Store");
```

### Stress Testing

1. Prepare Functions and Settings

```typescript
// Configuration for test stores and their options
const config = [
	{
		name: "jsonStress",
		options: {
			dataType: "JSON",
			bufferSize: 50 * 1024 * 1024,
			totalRows: 200000,
		},
	},
	{
		name: "float32Stress",
		options: {
			dataType: "TypedArray",
			typedArrayType: "Float32Array",
			bufferSize: 50 * 1024 * 1024,
			totalRows: 200000,
		},
	},
	{
		name: "float64Stress",
		options: {
			dataType: "TypedArray",
			typedArrayType: "Float64Array",
			bufferSize: 50 * 1024 * 1024,
			totalRows: 200000,
		},
	},
	{
		name: "int32Stress",
		options: {
			dataType: "TypedArray",
			typedArrayType: "Int32Array",
			bufferSize: 50 * 1024 * 1024,
			totalRows: 200000,
		},
	},
	{
		name: "uint8Stress",
		options: {
			dataType: "TypedArray",
			typedArrayType: "Uint8Array",
			bufferSize: 50 * 1024 * 1024,
			totalRows: 200000,
		},
	},
];

function createJsonObject(bytes: number): object {
	const baseObj = { type: "rand", randomVals: [] as number[] };
	while (JSON.stringify(baseObj).length < bytes) {
		baseObj.randomVals.push(Math.floor(Math.random() * 1000));
	}
	return baseObj;
}
```

2. Write the Test Code

```typescript
// Array to store test results
const results: {
	store: string;
	addRate: number;
	putRate: number;
	delRate: number;
}[] = [];

let totalAddOps = 0;
let totalPutOps = 0;
let totalDelOps = 0;

for (const cfg of config) {
	const { name, options } = cfg;
	console.log(`[INFO] Creating store: ${name}`);
	videoDB.createObjectStore(name, options);

	// Create the data object
	let dataObj: any = null;
	if (options.dataType === "JSON") {
		dataObj = createJsonObject(1024);
	} else {
		// Create a TypedArray with 256 numbers (1KB for float32/64, etc.)
		const floatCount = 1024 / 4;
		const typedArrayCtor = globalThis[options.typedArrayType] as any;
		dataObj = new typedArrayCtor(floatCount);
		for (let i = 0; i < floatCount; i++) {
			dataObj[i] = Math.random() * 1000;
		}
	}

	const testDurationSeconds = 5;

	// ADD operation performance test
	const addRate = await runPerfPhase(
		name,
		"add",
		dataObj,
		testDurationSeconds * 1000
	);
	const addOps = Math.floor(addRate * testDurationSeconds); // Approximate total ADD operations
	totalAddOps += addOps;
	await new Promise((resolve) => setTimeout(resolve, 250));

	// PUT operation performance test
	const putRate = await runPerfPhase(
		name,
		"put",
		dataObj,
		testDurationSeconds * 1000
	);
	const putOps = Math.floor(putRate * testDurationSeconds); // Approximate total PUT operations
	totalPutOps += putOps;
	await new Promise((resolve) => setTimeout(resolve, 250));

	// DELETE operation performance test
	const delRate = await runDeletePhase(name, testDurationSeconds * 1000);
	const delOps = Math.floor(delRate * testDurationSeconds); // Approximate total DELETE operations
	totalDelOps += delOps;
	await new Promise((resolve) => setTimeout(resolve, 250));

	results.push({ store: name, addRate, putRate, delRate });
	await new Promise((resolve) => setTimeout(resolve, 500));
}

// Calculate total data processed (1KB per ADD/PUT operation)
const totalDataKB = (totalAddOps + totalPutOps) * 1;

let totalDataStr = "";
if (totalDataKB >= 1024 * 1024) {
	// 1GB = 1,048,576 KB
	const totalDataGB = (totalDataKB / (1024 * 1024)).toFixed(2);
	totalDataStr = `${totalDataGB} GB`;
} else {
	const totalDataMB = (totalDataKB / 1024).toFixed(2);
	totalDataStr = `${totalDataMB} MB`;
}

// Print the performance results for each store
for (const r of results) {
	console.log(`${r.store}:`);
	console.log(`ADD = ${r.addRate.toLocaleString()} rec/sec`);
	console.log(`PUT = ${r.putRate.toLocaleString()} rec/sec`);
	console.log(`DEL = ${r.delRate.toLocaleString()} rec/sec`);
}
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
