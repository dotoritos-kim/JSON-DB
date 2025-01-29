# JSON-DB

## 소개 (Introduction)

**한국어(KR)**  
**JSON-DB**는 WebGPU를 활용해 대용량 JSON 데이터를 GPU 메모리에 효율적으로 저장하고, CPU에는 메타데이터만 두어 빠른 연산과 정렬을 가능하게 하는 프로젝트입니다. `JsonGpuStore`와 `VramDataBase` 클래스 등을 통해 JSON, TypedArray, ArrayBuffer 형태의 데이터 관리 및 GPU 정렬 기능을 제공합니다.

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
git clone https://github.com/<username>/JSON-DB.git
cd JSON-DB
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
const jsonGpu = new JsonGpuStore("HighLevelStore", "myKey", initialData, {
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
				db.createObjectStore(
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
JSON-DB/
├── VramDataBase.ts       # WebGPU 기반 데이터베이스 핵심 로직
├── JsonGpuStore.ts       # Proxy 기반 JSON 관리 클래스
├── types
│   └── StoreMetadata.ts  # 타입 및 인터페이스 정의
├── utils.ts              # 유틸리티 함수들
├── README.md             # 본 README
└── ...
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

**[Apache-2.0 license](LICENSE)**  
자세한 내용은 `LICENSE` 파일을 참고하세요.
