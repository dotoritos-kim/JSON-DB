# Json-VR-Cache

![Json-VR-Cache](favicon.ico)

[README-EN](https://github.com/dotoritos-kim/Json-VR-Cache/blob/main/README.md)

[README-KR](https://github.com/dotoritos-kim/Json-VR-Cache/blob/main/README-KR.md)

## 소개 (Introduction)

**한국어(KR)**  
**Json-VR-Cache**는 WebGPU를 활용해 대용량 JSON 데이터를 GPU 메모리에 효율적으로 저장하고, CPU에는 메타데이터만 두어 빠른 연산과 정렬을 가능하게 하는 프로젝트입니다. `JsonGpuStore`와 `VramDataBase` 클래스 등을 통해 JSON, TypedArray, ArrayBuffer 형태의 데이터 관리 및 GPU 정렬 기능을 제공합니다.

---

## 주요 기능 (Key Features)

---

### 1) `JsonGpuStore`

**한국어(KR)**

-   **Proxy 기반 JSON 관리**: JSON 데이터를 Proxy로 감싸, 수정 시 GPU DB(`VramDataBase`)에 자동으로 반영합니다.
-   **WebGPU 디바이스 자동 획득**: 내부적으로 `getWebGpuDevice()`를 통해 WebGPU 디바이스를 요청합니다.
-   **초기화**: 생성 시 `dataType: "JSON"` 스토어를 만들고, 초기 JSON 객체를 자동으로 저장합니다.
-   **실시간 반영**: Proxy 객체를 수정할 때마다 `put`이 실행되어 GPU에 변경 사항이 반영됩니다.

---

### 2) `VramDataBase`

**한국어(KR)**

-   **다양한 데이터 타입**: JSON, TypedArray, ArrayBuffer 등의 형태를 지원합니다.
-   **GPU 버퍼 사용**: 데이터 본문을 GPU 버퍼에 저장, CPU에는 메타데이터만 두어 빠르게 접근합니다.
-   **오브젝트 스토어**: `createObjectStore`, `deleteObjectStore`로 스토어를 만들고 없애며, `listObjectStores`로 조회할 수 있습니다.
-   **CRUD 기능**: `add`, `put`, `get`, `getMultiple`, `delete` 메서드로 데이터를 조작합니다.
-   **배치/지연 쓰기**: 쓰기 요청을 `pendingWrites`에 모아서 한 번에 GPU에 플러시합니다(배치 크기 또는 타이머 기반).
-   **JSON 정렬**: JSON 스토어에 `sortDefinition`을 설정하면 `<storeName>-offsets` 스토어를 자동 생성해 GPU 정렬을 위한 숫자 오프셋을 저장합니다.
-   **페이지네이션 & 와일드카드**: `getMultiple`을 통해 (skip/take) 페이지네이션, `%`, `_`, `[]` 와 같은 SQL 스타일 와일드카드를 지원합니다.
-   **커서(Cursor)**: `openCursor`로 범위와 방향(`next`, `prev`)을 지정해 레코드를 순회할 수 있습니다.
-   **GPU 정렬**: 비토닉 정렬(bitonic sort) 알고리즘을 통해 매우 빠른 정렬을 지원합니다.

---

## 빠른 시작 (Quick Start)

### 1. 저장소 클론 & 의존성 설치 (Clone & Install)

```bash
git clone https://github.com/<username>/Json-VR-Cache.git
cd Json-VR-Cache
npm install
```

### 2. 빌드 (Build/Compile)

```bash
npm run build
```

### 3. 예제 코드 (Example Code)

아래 예시는 TypeScript를 기준으로 작성되었으며, JavaScript에서도 유사하게 동작합니다.

```ts
const initialData = { count: 0, nested: { value: 10 } };
const jsonGpu = new JsonGpuStore("HighLevelStore", "myKey", initialData);

await jsonGPU.init({
	dataType: "JSON",
	bufferSize: 1024 * 1024,
	totalRows: 1,
});

// Proxy 객체
const proxyData = jsonGpu.getProxy();

// Proxy 수정 -> 자동으로 GPU DB에 반영됨
proxyData.count = 999;
proxyData.nested.value = 888;
```

---

아래 예시는 Typescript + react를 기준으로 작성되었습니다.

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

## 디렉토리 구조 (Directory Structure)

```plaintext
Json-VR-Cache/
├── vramDataBase.ts       # WebGPU 기반 데이터베이스 핵심 로직
├── JsonGpuStore.ts       # Proxy 기반 JSON 관리 클래스
├── types
│   └── StoreMetadata.ts  # 타입 및 인터페이스 정의
├── utils.ts              # 유틸리티 함수들
├── README.md             # 본 README
└── ...
```

---

## 테스트

### 사용자의 브라우저에서 WebGPU가 지원되는지 빠르게 확인하세요.

```typescript
const device = await getWebGpuDevice();

if (!device) {
	console.error("Failed to get GPU adapter.");
	return;
}
```

### 모든 데이터 타입의 저장소를 테스트 해보세요.

```typescript
// VramDataBase 생성
const device = await getWebGpuDevice();
const db = new VramDataBase(device);
```

```typescript
// [단계] 스토어 생성: jsonStore
vramDataBase.StoreManager.createObjectStore("jsonStore", {
	dataType: "JSON",
	bufferSize: 1048576,
	totalRows: 50,
});

// [단계] 데이터 추가 (키가 이미 있으면 실패)
const dataToAdd = { greeting: "Hello JSON Store!", time: 1738402167838 };
await vramDataBase.StoreManager.add("jsonStore", "JsonKey", dataToAdd);

// [단계] 데이터 조회
const retrievedAdd = await vramDataBase.StoreManager.get(
	"jsonStore",
	"JsonKey"
);
console.log("추가 후 조회:", retrievedAdd);

// [단계] 데이터 수정 (기존 키 덮어쓰기)
const updatedData = { updatedField: "newValue", time: 1738402173462 };
await vramDataBase.StoreManager.put("jsonStore", "JsonKey", updatedData);

// [단계] OpenCursor를 사용하여 모든 키/값 보기
for await (const record of vramDataBase.StoreManager.openCursor("jsonStore")) {
	console.log(record.key, record.value);
}

// [단계] 특정 키를 가진 단일 레코드 삭제
await vramDataBase.StoreManager.delete("jsonStore", "JsonKey");

// [단계] 스토어 삭제
vramDataBase.StoreManager.deleteObjectStore("jsonStore");

// [단계] 스토어 생성: float32Store
vramDataBase.StoreManager.createObjectStore("float32Store", {
	dataType: "TypedArray",
	typedArrayType: "Float32Array",
	bufferSize: 1048576,
	totalRows: 50,
});

// [단계] 데이터 추가 (키가 이미 있으면 실패)
const dataToAddFloat32 = new Float32Array([
	1.1100000143051147, 2.2200000286102295, 3.3299999237060547,
]);
await vramDataBase.StoreManager.add(
	"float32Store",
	"myFloat32Key",
	dataToAddFloat32
);

// [단계] 데이터 조회
const retrievedAddFloat32 = await vramDataBase.StoreManager.get(
	"float32Store",
	"myFloat32Key"
);
console.log("추가 후 조회:", retrievedAddFloat32);

// [단계] 데이터 수정 (기존 키 덮어쓰기)
const updatedDataFloat32 = new Float32Array([9, 8, 7]);
await vramDataBase.StoreManager.put(
	"float32Store",
	"myFloat32Key",
	updatedDataFloat32
);

// [단계] OpenCursor를 사용하여 모든 키/값 보기
for await (const record of vramDataBase.StoreManager.openCursor(
	"float32Store"
)) {
	console.log(record.key, record.value);
}

// [단계] 특정 키를 가진 단일 레코드 삭제
await vramDataBase.StoreManager.delete("float32Store", "myFloat32Key");

// [단계] 스토어 삭제
vramDataBase.StoreManager.deleteObjectStore("float32Store");

// [단계] 스토어 생성: float64Store
vramDataBase.StoreManager.createObjectStore("float64Store", {
	dataType: "TypedArray",
	typedArrayType: "Float64Array",
	bufferSize: 1048576,
	totalRows: 50,
});

// [단계] 데이터 추가 (키가 이미 있으면 실패)
const dataToAddFloat64 = new Float64Array([10.01, 20.02, 30.03]);
await vramDataBase.StoreManager.add(
	"float64Store",
	"Float64Key",
	dataToAddFloat64
);

// [단계] 데이터 조회
const retrievedAddFloat64 = await vramDataBase.StoreManager.get(
	"float64Store",
	"Float64Key"
);
console.log("추가 후 조회:", retrievedAddFloat64);

// [단계] 데이터 수정 (기존 키 덮어쓰기)
const updatedDataFloat64 = new Float64Array([9, 8, 7]);
await vramDataBase.StoreManager.put(
	"float64Store",
	"Float64Key",
	updatedDataFloat64
);

// [단계] OpenCursor를 사용하여 모든 키/값 보기
for await (const record of vramDataBase.StoreManager.openCursor(
	"float64Store"
)) {
	console.log(record.key, record.value);
}

// [단계] 특정 키를 가진 단일 레코드 삭제
await vramDataBase.StoreManager.delete("float64Store", "Float64Key");

// [단계] 스토어 삭제
vramDataBase.StoreManager.deleteObjectStore("float64Store");

// [단계] 스토어 생성: int32Store
vramDataBase.StoreManager.createObjectStore("int32Store", {
	dataType: "TypedArray",
	typedArrayType: "Int32Array",
	bufferSize: 2048000,
	totalRows: 100,
});

// [단계] 데이터 추가 (키가 이미 있으면 실패)
const dataToAddInt32 = new Int32Array([-1, 0, 99999]);
await vramDataBase.StoreManager.add("int32Store", "Int32Key", dataToAddInt32);

// [단계] 데이터 조회
const retrievedAddInt32 = await vramDataBase.StoreManager.get(
	"int32Store",
	"Int32Key"
);
console.log("추가 후 조회:", retrievedAddInt32);

// [단계] 데이터 수정 (기존 키 덮어쓰기)
const updatedDataInt32 = new Int32Array([9, 8, 7]);
await vramDataBase.StoreManager.put("int32Store", "Int32Key", updatedDataInt32);

// [단계] OpenCursor를 사용하여 모든 키/값 보기
for await (const record of vramDataBase.StoreManager.openCursor("int32Store")) {
	console.log(record.key, record.value);
}

// [단계] 특정 키를 가진 단일 레코드 삭제
await vramDataBase.StoreManager.delete("int32Store", "Int32Key");

// [단계] 스토어 삭제
vramDataBase.StoreManager.deleteObjectStore("int32Store");

// [단계] 스토어 생성: uint32Store
vramDataBase.StoreManager.createObjectStore("uint32Store", {
	dataType: "TypedArray",
	typedArrayType: "Uint32Array",
	bufferSize: 1048576,
	totalRows: 50,
});

// [단계] 데이터 추가 (키가 이미 있으면 실패)
const dataToAddUint32 = new Uint32Array([1, 2, 3]);
await vramDataBase.StoreManager.add(
	"uint32Store",
	"Uint32Key",
	dataToAddUint32
);

// [단계] 데이터 조회
const retrievedAddUint32 = await vramDataBase.StoreManager.get(
	"uint32Store",
	"Uint32Key"
);
console.log("추가 후 조회:", retrievedAddUint32);

// [단계] 데이터 수정 (기존 키 덮어쓰기)
const updatedDataUint32 = new Uint32Array([1, 2, 3]);
await vramDataBase.StoreManager.put(
	"uint32Store",
	"Uint32Key",
	updatedDataUint32
);

// [단계] OpenCursor를 사용하여 모든 키/값 보기
for await (const record of vramDataBase.StoreManager.openCursor(
	"uint32Store"
)) {
	console.log(record.key, record.value);
}

// [단계] 특정 키를 가진 단일 레코드 삭제
await vramDataBase.StoreManager.delete("uint32Store", "Uint32Key");

// [단계] 스토어 삭제
vramDataBase.StoreManager.deleteObjectStore("uint32Store");

// [단계] 스토어 생성: uint8Store
vramDataBase.StoreManager.createObjectStore("uint8Store", {
	dataType: "TypedArray",
	typedArrayType: "Uint8Array",
	bufferSize: 2048000,
	totalRows: 100,
});

// [단계] 데이터 추가 (키가 이미 있으면 실패)
const dataToAddUint8 = new Uint8Array([0, 255, 128, 64]);
await vramDataBase.StoreManager.add("uint8Store", "Uint8Key", dataToAddUint8);

// [단계] 데이터 조회
const retrievedAddUint8 = await vramDataBase.StoreManager.get(
	"uint8Store",
	"Uint8Key"
);
console.log("추가 후 조회:", retrievedAddUint8);

// [단계] 데이터 수정 (기존 키 덮어쓰기)
const updatedDataUint8 = new Uint8Array([9, 8, 7]);
await vramDataBase.StoreManager.put("uint8Store", "Uint8Key", updatedDataUint8);

// [단계] OpenCursor를 사용하여 모든 키/값 보기
for await (const record of vramDataBase.StoreManager.openCursor("uint8Store")) {
	console.log(record.key, record.value);
}

// [단계] 특정 키를 가진 단일 레코드 삭제
await vramDataBase.StoreManager.delete("uint8Store", "Uint8Key");

// [단계] 스토어 삭제
vramDataBase.StoreManager.deleteObjectStore("uint8Store");
```

### 부하 테스트를 시도해보세요.

1. 함수와 설정을 준비하세요.

```typescript
// 테스트 대상 스토어와 각 스토어의 옵션 설정
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

2. 테스트 코드를 작성하세요.

```typescript
// 테스트 결과를 저장할 배열
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

	// 데이터 객체 생성
	let dataObj: any = null;
	if (options.dataType === "JSON") {
		dataObj = createJsonObject(1024);
	} else {
		// 1KB 데이터를 위해 1024/4 = 256개의 숫자 배열 생성 (Float32Array, Float64Array 등)
		const floatCount = 1024 / 4;
		const typedArrayCtor = globalThis[options.typedArrayType] as any;
		dataObj = new typedArrayCtor(floatCount);
		for (let i = 0; i < floatCount; i++) {
			dataObj[i] = Math.random() * 1000;
		}
	}

	const testDurationSeconds = 5;

	// ADD 작업 성능 테스트
	const addRate = await runPerfPhase(
		name,
		"add",
		dataObj,
		testDurationSeconds * 1000
	);
	const addOps = Math.floor(addRate * testDurationSeconds); // 대략적인 총 ADD 횟수
	totalAddOps += addOps;
	await new Promise((resolve) => setTimeout(resolve, 250));

	// PUT 작업 성능 테스트
	const putRate = await runPerfPhase(
		name,
		"put",
		dataObj,
		testDurationSeconds * 1000
	);
	const putOps = Math.floor(putRate * testDurationSeconds); // 대략적인 총 PUT 횟수
	totalPutOps += putOps;
	await new Promise((resolve) => setTimeout(resolve, 250));

	// DELETE 작업 성능 테스트
	const delRate = await runDeletePhase(name, testDurationSeconds * 1000);
	const delOps = Math.floor(delRate * testDurationSeconds); // 대략적인 총 DELETE 횟수
	totalDelOps += delOps;
	await new Promise((resolve) => setTimeout(resolve, 250));

	results.push({ store: name, addRate, putRate, delRate });
	await new Promise((resolve) => setTimeout(resolve, 500));
}

// 총 데이터 처리량 계산 (ADD 및 PUT 작업 기준, 각 작업당 1KB 처리)
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

// 각 스토어의 성능 결과 출력
for (const r of results) {
	console.log(`${r.store}:`);
	console.log(`ADD = ${r.addRate.toLocaleString()} rec/sec`);
	console.log(`PUT = ${r.putRate.toLocaleString()} rec/sec`);
	console.log(`DEL = ${r.delRate.toLocaleString()} rec/sec`);
}
```

---

## 내부 동작 (Implementation Details)

**한국어(KR)**

-   **배치 쓰기**: 쓰기를 `pendingWrites` 큐에 쌓았다가 일정 배치 크기나 타이머가 만료되면 한 번에 GPU에 반영
-   **정렬 정의**: JSON 스토어에 `sortDefinition`을 두면 `<storeName>-offsets` 스토어가 만들어져 GPU 정렬을 위한 필드 오프셋을 관리
-   **비토닉 정렬**: WGSL 기반의 컴퓨트 셰이더를 사용해 `(rowId + 필드값)` 튜플을 빠르게 정렬
-   **메모리 한계**: `maxStorageBufferBindingSize`를 초과하는 경우 GPU 정렬 과정이 중단될 수 있음
-   **와일드카드**: `%`, `_`, `[]` 등 SQL 스타일의 LIKE 문법을 JavaScript 정규식으로 변환하여 사용 가능

---

## 기여 (Contributing)

**한국어(KR)**  
오류 제보나 기능 개선 제안, PR은 언제든 환영합니다.

---

## 라이선스 (License)

**[GNU General Public License (GPLv2)](LICENSE)**  
자세한 내용은 `LICENSE` 파일을 참고하세요.
