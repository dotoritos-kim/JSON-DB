// types/StoreMetadata.ts

/**
 * 전체 스토어에 대한 메타데이터 정보를 담는 인터페이스
 */
export interface StoreMetadata {
	/** 스토어 이름 */
	storeName: string;

	/** 데이터 종류 */
	dataType: "TypedArray" | "ArrayBuffer" | "JSON";

	/**
	 * TypedArray인 경우, 어느 TypedArray인지 (Float32Array, Int32Array 등등)
	 * dataType이 "TypedArray"인 경우에만 유효
	 */
	typedArrayType?:
		| "Float32Array"
		| "Float64Array"
		| "Int32Array"
		| "Uint32Array"
		| "Uint8Array";

	/** GPU에 할당할 기본 버퍼 크기(바이트 단위) */
	bufferSize: number;

	/** 레코드 1건이 차지하는 바이트 수 (TypedArray/ArrayBuffer 전용) */
	rowSize?: number;

	/** bufferSize / rowSize 로 계산된 1버퍼에 들어갈 수 있는 row 개수 */
	rowsPerBuffer?: number;

	/** 전체 레코드(행) 수 */
	totalRows: number;

	/** GPU 버퍼 목록 */
	buffers: BufferMetadata[];

	/** 현재 스토어의 RowMetadata 목록 */
	rows: RowMetadata[];

	/**
	 * JSON 스토어의 경우, 정렬 정의(필드 path, Asc/Desc 등).
	 * TypedArray/ArrayBuffer인 경우 보통 사용하지 않음
	 */
	sortDefinition?: SortDefinition[];

	/**
	 * 정렬 정의가 “더티” 상태인지(= 재정렬 필요).
	 * 새로운 데이터가 들어왔을 때 true가 됨
	 */
	sortsDirty: boolean;
}

/**
 * 하나의 GPU Buffer에 대한 메타데이터
 * - bufferIndex: 스토어 내부에서 버퍼를 구분하는 인덱스
 * - startRow, rowCount: 이 버퍼가 몇 번 row부터 담당하는지 (선택 사항)
 */
export interface BufferMetadata {
	bufferIndex: number;
	startRow: number;
	rowCount: number;
	gpuBuffer?: GPUBuffer;
}

/**
 * 스토어 내 하나의 레코드(Row)에 대한 메타데이터
 * - rowId: 내부에서 사용하는 ID (1부터 시작할 수도 있고, 임의)
 * - bufferIndex: 이 로우가 어느 GPU 버퍼에 들어있는지
 * - offset: 그 버퍼 내 바이트 오프셋
 * - length: 실제 데이터 길이(바이트)
 * - flags: 상태 플래그 (예: ROW_INACTIVE_FLAG 등)
 */
export interface RowMetadata {
	rowId: number;
	bufferIndex: number;
	offset: number;
	length: number;
	flags?: number;
}

/**
 * JsonDB가 내부적으로 쓰는 “getMultiple” 등에서의 초기 메트릭 측정값
 * - flushWrites: 플러시(writeBuffer 등)하는 데 걸린 시간(ms)
 * - metadataRetrieval: 스토어 메타/키맵을 가져오는 데 걸린 시간(ms)
 */
export interface InitialMetrics {
	flushWrites: number; // ms
	metadataRetrieval: number; // ms
}

/**
 * 한 번의 getMultiple 호출 시, key별 로우 찾기나 readBuffer 등
 * 상세 항목별로 걸린 시간을 담는 구조체
 */
export interface PerKeyMetrics {
	findMetadata: number; // 모든 키의 메타데이터 찾는 데 걸린 총 시간
	createBuffer: number; // bigReadBuffer 생성에 걸린 시간
	copyBuffer: number; // copyBufferToBuffer 실행에 걸린 시간
	mapBuffer: number; // stagingBuffer mapAsync 등 전체 시간
	deserialize: number; // bytes → 실제 오브젝트(또는 TypedArray) 역직렬화하는 데 걸린 시간
	mapBufferSubsections: MapBufferSubsections;
}

/**
 * mapBuffer 과정 세부 항목별 시간
 */
export interface MapBufferSubsections {
	mapAsync: number; // mapAsync() 호출 및 대기 시간
	getMappedRange: number; // buffer.getMappedRange() 호출 시간
	copyToUint8Array: number; // getMappedRange()로부터 Uint8Array로 복사 시간
	unmap: number; // unmap() 호출 시간
}

/**
 * getMultiple에서 내부적으로 각 key마다 row를 읽을 때 사용되는 구조
 */
export interface RowInfo {
	rowMetadata: RowMetadata;
	rowIndex: number; // 이 row가 결과 배열에서 몇 번째 인덱스에 대응하는지
	offsetInFinalBuffer: number; // bigReadBuffer 안에서의 위치
	length: number; // rowMetadata.length
}

/**
 * JSON 스토어에서 SortDefinition을 지정할 때 쓰이는 구조
 */
export interface SortDefinition {
	name: string; // 예: "SortByDate", "SortByName"
	sortFields: SortField[]; // 실제 정렬할 필드들
}

/**
 * sortFields 배열 안에 들어가는 각각의 필드 정의
 * - sortColumn: 컬럼명(또는 식별자)
 * - path: JSON 객체 안에서 값을 찾기 위한 dot-path
 * - sortDirection: "Asc" | "Desc"
 * - dataType: 내부 용도("string" | "number" | "date" 등)
 */
export interface SortField {
	sortColumn: string;
	path: string;
	sortDirection: "Asc" | "Desc";
	dataType: "string" | "number" | "date";
}

/**
 * JsonDB에서 add/put/delete를 스케줄링할 때 사용하는 대기열 항목
 */
export interface PendingWrite {
	storeMeta: StoreMetadata;
	rowMetadata: RowMetadata;
	arrayBuffer: ArrayBuffer;
	gpuBuffer: GPUBuffer;
	operationType: "add" | "put" | "delete";
	/** delete 시나리오처럼, 일부 경우 key를 후속 처리에 쓰기도 함 */
	key?: string;
}

/**
 * 예시로, Row ID 패딩 결과를 반환해야 하는 상황이 있다면
 * 아래처럼 정의할 수 있음(현재 코드에서는 사용되지 않으므로 임의 예시).
 */
export interface RowIdPaddingResult {
	newRowId: number;
	oldRowId?: number;
	wasReallocated?: boolean;
}

export interface IDBOptions {
	dataType: "TypedArray" | "ArrayBuffer" | "JSON";
	typedArrayType?:
		| "Float32Array"
		| "Float64Array"
		| "Int32Array"
		| "Uint32Array"
		| "Uint8Array";
	bufferSize: number;
	rowSize?: number;
	totalRows: number;
	sortDefinition?: {
		name: string;
		sortFields: {
			sortColumn: string;
			path: string;
			sortDirection: "Asc" | "Desc";
		}[];
	}[];
}
