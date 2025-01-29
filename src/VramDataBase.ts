import {
	StoreMetadata,
	BufferMetadata,
	RowMetadata,
	InitialMetrics,
	MapBufferSubsections,
	PerKeyMetrics,
	RowInfo,
	SortDefinition,
	SortField,
	PendingWrite,
	RowIdPaddingResult,
	IDBOptions,
} from "./types/StoreMetadata";
import {
	compareKeys,
	likeToRegex,
	padJsonTo4Bytes,
	padTo4Bytes,
	roundUp,
	ROW_INACTIVE_FLAG,
} from "./utils";

/**
 * CPU 메모리에 모든 메타데이터를 저장하고,
 * 실제 데이터를 GPU에 저장하는 VramDataBase 클래스
 */
export class VramDataBase {
	public storeMetadataMap: Map<string, StoreMetadata>;
	public storeKeyMap: Map<string, Map<string, number>>;
	public pendingWrites: PendingWrite[] = [];
	private readonly BATCH_SIZE = 10000;
	private flushTimer: number | null = null;
	public isReady: boolean | null = true;
	private waitUntilReadyPromise: Promise<void> | null = null;
	private readyResolver: (() => void) | null = null;
	private float64Buffer = new ArrayBuffer(8);
	private float64View = new DataView(this.float64Buffer);
	private dateParseCache = new Map<string, number>();
	private stringCache = new Map<string, Uint32Array>();

	/**
	 * VramDataBase 클래스를 초기화한다.
	 * @param {GPUDevice} device - 버퍼 작업에 사용할 GPU 디바이스
	 */
	constructor(private device: GPUDevice) {
		this.storeMetadataMap = new Map();
		this.storeKeyMap = new Map();
	}
	/**
	 * 지정된 구성 옵션을 사용하여 새 오브젝트 스토어를 생성한다.
	 * 만약 `dataType: "JSON"`이고, 하나 이상의 `sortDefinition`이 존재한다면
	 * `<storeName>-offsets` 라는 이름의 동반 오프셋 스토어( `dataType: "TypedArray"`, `typedArrayType: "Uint32Array"` )를 생성하여,
	 * JSON 필드에서 추출한 정렬 키(숫자)를 저장한다.
	 *
	 * @param {string} storeName - 생성할 스토어 이름
	 * @param {{
	 *   dataType: "TypedArray" | "ArrayBuffer" | "JSON";
	 *   typedArrayType?:
	 *     | "Float32Array"
	 *     | "Float64Array"
	 *     | "Int32Array"
	 *     | "Uint32Array"
	 *     | "Uint8Array";
	 *   bufferSize: number;
	 *   rowSize?: number;
	 *   totalRows: number;
	 *   sortDefinition?: {
	 *     name: string;
	 *     sortFields: {
	 *       sortColumn: string;
	 *       path: string;
	 *       sortDirection: "Asc" | "Desc";
	 *     }[];
	 *   }[];
	 * }} options - 새 스토어에 대한 구성 옵션
	 * @returns {void}
	 * @throws {Error} 이미 스토어가 존재하거나, `dataType`이 "TypedArray"인데 `typedArrayType`이 누락된 경우 에러를 발생
	 */

	public createObjectStore(storeName: string, options: IDBOptions): void {
		// 1) 같은 이름의 스토어가 이미 존재하는지 확인. 존재하면 에러 발생.
		if (this.storeMetadataMap.has(storeName)) {
			throw new Error(`Object store "${storeName}" already exists.`);
		}

		// 2) dataType이 "TypedArray"라면 typedArrayType이 반드시 있어야 한다.
		if (options.dataType === "TypedArray" && !options.typedArrayType) {
			throw new Error(
				`typedArrayType is required when dataType is "TypedArray".`
			);
		}

		// 3) dataType이 "JSON"이 아니라면, rowSize가 주어졌을 때 bufferSize로부터 한 버퍼에 몇 개의 행을 담을 수 있는지 계산한다.
		//    그렇지 않다면 undefined로 둔다.
		const rowsPerBuffer =
			options.dataType !== "JSON" && options.rowSize
				? Math.floor(options.bufferSize / options.rowSize)
				: undefined;

		// 4) 새 오브젝트 스토어를 설명하는 StoreMetadata 객체를 만든다.
		const storeMetadata: StoreMetadata = {
			storeName,
			dataType: options.dataType,
			typedArrayType: options.typedArrayType,
			bufferSize: options.bufferSize,
			rowSize: options.rowSize,
			rowsPerBuffer,
			totalRows: options.totalRows,
			buffers: [], // 아직 버퍼를 할당하지 않음
			rows: [], // 초기에는 빈 행 목록
			// 4a) 모든 sortDefinition을 내부 포맷으로 변환. 여기서는 모든 필드 타입을 기본적으로 "string"으로 표시한다.
			sortDefinition:
				options.sortDefinition?.map((def) => ({
					name: def.name,
					sortFields: def.sortFields.map((field) => ({
						dataType: "string",
						...field,
					})),
				})) ?? [],
			sortsDirty: false,
		};

		// 5) 새 스토어 메타데이터를 storeMetadataMap에 저장한다.
		this.storeMetadataMap.set(storeName, storeMetadata);
		// 5a) storeKeyMap에도 비어 있는 keyMap을 등록한다.
		this.storeKeyMap.set(storeName, new Map());

		// 6) JSON 타입 스토어면서 하나 이상의 sortDefinition이 있다면, "offsets" 스토어도 생성한다.
		if (
			options.dataType === "JSON" &&
			options.sortDefinition &&
			options.sortDefinition.length
		) {
			// 6a) 모든 sortDefinition에서 필요한 필드의 총 개수를 구한다.
			const totalSortFields = options.sortDefinition.reduce(
				(count, def) => count + def.sortFields.length,
				0
			);

			// 6c) typedArrayType = "Uint32Array" 이고 버퍼 사이즈가 큰 동반 offsets 스토어를 생성한다.
			this.createObjectStore(`${storeName}-offsets`, {
				dataType: "TypedArray",
				typedArrayType: "Uint32Array",
				bufferSize: 10 * 1024 * 1024,
				totalRows: options.totalRows,
			});
		}
	}

	/**
	 * 특정 이름의 기존 오브젝트 스토어를 삭제한다.
	 * @param {string} storeName - 삭제할 스토어 이름
	 * @returns {void} 반환값 없음
	 */
	public deleteObjectStore(storeName: string): void {
		if (!this.storeMetadataMap.has(storeName)) {
			return;
		}
		this.storeMetadataMap.delete(storeName);
		this.storeKeyMap.delete(storeName);
	}

	/**
	 * 존재하는 모든 오브젝트 스토어 이름 목록을 가져온다.
	 * @returns {string[]} 모든 스토어 이름이 들어 있는 배열
	 */
	public listObjectStores(): string[] {
		return Array.from(this.storeMetadataMap.keys());
	}

	/**
	 * 지연된 GPU 쓰기 형태로, 지정된 스토어에 새 레코드를 추가한다.
	 * 스토어가 JSON 정렬 정의를 가지고 있다면, 오프셋도 함께 계산하여 저장한다.
	 *
	 * @async
	 * @function
	 * @name add
	 * @memberof YourClassName
	 * @param {string} storeName - 레코드를 추가할 스토어 이름
	 * @param {string} key - 레코드를 저장할 때 사용할 키
	 * @param {*} value - 추가할 레코드 데이터
	 * @returns {Promise<void>} 레코드 추가가 완료되면 resolve되는 프로미스
	 * @throws {Error} 지정한 스토어가 존재하지 않을 경우 에러를 발생
	 */
	public async add(
		storeName: string,
		key: string,
		value: any
	): Promise<void> {
		this.isReady = false;

		const storeMeta = this.storeMetadataMap.get(storeName);
		if (!storeMeta) {
			throw new Error(`Object store "${storeName}" does not exist.`);
		}

		// 1) 메인 레코드 쓰기
		await this.writeRecordToStore(storeMeta, key, value, "add");

		// 2) JSON 타입에 정렬 정의가 있다면, 모든 오프셋을 처리
		if (storeMeta.dataType === "JSON" && storeMeta.sortDefinition?.length) {
			storeMeta.sortsDirty = true; // 더티 플래그 설정
			await this.writeOffsetsForAllDefinitions(
				storeMeta,
				key,
				value,
				"add"
			);
		}

		// 3) flush 타이머 리셋 및 플러시 수행 가능성 확인
		this.resetFlushTimer();
		await this.checkAndFlush();
	}

	/**
	 * 지정된 스토어에 레코드를 업데이트(또는 추가)한다. 이 역시 지연된 GPU 쓰기로 동작한다.
	 * 스토어가 JSON 정렬 정의를 가지고 있다면, 오프셋도 함께 계산하여 저장한다.
	 *
	 * @async
	 * @function
	 * @name put
	 * @memberof YourClassName
	 * @param {string} storeName - 업데이트할 스토어 이름
	 * @param {string} key - 레코드가 저장되거나 업데이트될 키
	 * @param {*} value - 저장 또는 업데이트할 레코드 데이터
	 * @returns {Promise<void>} 레코드가 처리되면 resolve되는 프로미스
	 * @throws {Error} 지정한 스토어가 존재하지 않을 경우 에러를 발생
	 */
	public async put(
		storeName: string,
		key: string,
		value: any
	): Promise<void> {
		this.isReady = false;

		const storeMeta = this.storeMetadataMap.get(storeName);
		if (!storeMeta) {
			throw new Error(`Object store "${storeName}" does not exist.`);
		}

		// 1) 메인 레코드 쓰기
		await this.writeRecordToStore(storeMeta, key, value, "put");

		// 2) JSON 타입에 정렬 정의가 있다면, 모든 오프셋을 처리
		if (storeMeta.dataType === "JSON" && storeMeta.sortDefinition?.length) {
			storeMeta.sortsDirty = true;
			await this.writeOffsetsForAllDefinitions(
				storeMeta,
				key,
				value,
				"put"
			);
		}

		// 3) flush 타이머 리셋 및 플러시 수행 가능성 확인
		this.resetFlushTimer();
		await this.checkAndFlush();
	}

	/**
	 * GPU 기반 스토어에서 특정 키의 데이터를 getMultiple 메서드를 통해 가져온다.
	 * 읽기 전에 모든 대기 중인 쓰기가 flush된다.
	 *
	 * @param {string} storeName - 오브젝트 스토어 이름
	 * @param {string} key - 가져올 행을 식별하는 고유 키
	 * @returns {Promise<any | null>} 찾은 데이터 또는 null
	 * @throws {Error} 스토어가 존재하지 않을 경우 에러를 발생
	 */
	public async get(storeName: string, key: string): Promise<any | null> {
		// 단일 키로 getMultiple 호출
		const results = await this.getMultiple(storeName, [key]);

		// 첫 번째(유일한) 결과 추출
		const result = results[0];

		return result;
	}

	/**
	 * 여러 레코드를 가져오는 기능을 제공한다. 두 가지 사용 패턴을 지원한다:
	 *
	 * 1. **키 배열로 가져오기**:
	 *    ```ts
	 *    const results = await VramDataBase.getMultiple("MyStore", ["key1", "key2", "key3"]);
	 *    ```
	 *    - 결과 배열 길이는 입력으로 준 `keys`와 동일.
	 *    - 각 위치에는 해당 키의 역직렬화된 데이터가 들어오며, 키가 없으면 null.
	 *    - 키에 와일드카드(%, _, [] 등)를 포함하면, 기존 키 중 패턴에 맞는 항목들을 확장하여 반환함.
	 *
	 * 2. **페이지네이션**:
	 *    ```ts
	 *    const results = await VramDataBase.getMultiple("MyStore", 0, 100);
	 *    ```
	 *    - 두 번째 인수를 `skip`, 세 번째 인수를 `take`로 해석.
	 *    - 내부적으로 해당 스토어의 모든 키를 가져온 뒤, `skip`부터 `skip + take - 1`까지 슬라이싱하여 반환.
	 *    - 반환 배열은 내부 keyMap의 순서를 따른다(키값에 의한 정렬이 아님).
	 *
	 * @param {string} storeName
	 *   데이터를 가져올 대상 스토어 이름
	 *
	 * @param {string[] | number} param2
	 *   - string[]인 경우, 가져오려는 특정 키(와일드카드 가능) 배열.
	 *   - number인 경우, 페이지네이션에서 skip으로 해석.
	 *
	 * @param {number} [param3]
	 *   - param2가 number일 때, 해당 값을 take로 사용.
	 *   - param2가 string[]이면 무시됨.
	 *
	 * @returns {Promise<(any|null)[]>}
	 *   역직렬화된 객체/TypedArray/ArrayBuffer 또는 null을 담는 결과 배열.
	 *   - “키 배열로 가져오기” 모드에서는 입력 키 순서에 대응.
	 *   - “페이지네이션” 모드에서는 내부 keyMap 순으로 skip~skip+take-1 범위.
	 *
	 * @throws {Error}
	 *   - 인자가 (storeName, string[]) 또는 (storeName, number, number) 형태가 아닐 경우.
	 *
	 * @example
	 * // 1) 특정 키로 가져오기
	 * const recordsByKey = await VramDataBase.getMultiple("MyStore", ["key1", "key2"]);
	 *
	 * @example
	 * // 2) 페이지네이션
	 * const firstHundredRecords = await VramDataBase.getMultiple("MyStore", 0, 100);
	 *
	 * @remarks
	 * - 일관성을 위해, 읽기 전에 모든 대기 중인 쓰기가 flush됨.
	 * - 와일드카드로 확장된 키는 원래 키 배열보다 많아질 수 있음.
	 * - 페이지네이션 모드에서 반환되는 순서는 키 정렬이 아니라 내부 keyMap 순서임.
	 */
	public async getMultiple(
		storeName: string,
		keys: string[]
	): Promise<(any | null)[]>;
	public async getMultiple(
		storeName: string,
		skip: number,
		take: number
	): Promise<(any | null)[]>;
	public async getMultiple(
		storeName: string,
		param2: string[] | number,
		param3?: number
	): Promise<(any | null)[]> {
		if (Array.isArray(param2)) {
			// 오버로드 1: 키 배열로 가져오기
			const keys = param2;
			const { results } = await this.getMultipleByKeys(storeName, keys);
			return results;
		} else if (typeof param2 === "number" && typeof param3 === "number") {
			// 오버로드 2: 페이지네이션 (skip, take)
			const skip = param2;
			const take = param3;

			// flush & 스토어 메타데이터 가져오기
			const { keyMap } = await this.flushAndGetMetadata(storeName);

			// 스토어의 keyMap을 배열로 바꾼다
			const allKeys = Array.from(keyMap.keys());

			const { results } = await this.readRowsWithPagination(
				storeName,
				allKeys,
				skip,
				take
			);
			return results;
		} else {
			throw new Error(
				"Invalid parameters for getMultiple. Expected either (storeName, keys[]) or (storeName, skip, take)."
			);
		}
	}

	/**
	 * GPU 기반 스토어에서 특정 키 데이터를 삭제한다(삭제 작업은 배치되어 flushWrites가 호출될 때 실제로 수행됨).
	 *
	 * @param {string} storeName - 오브젝트 스토어 이름
	 * @param {string} key - 삭제할 행의 키
	 * @returns {Promise<void>} 삭제 작업이 큐에 등록된 후 resolve
	 * @throws {Error} 스토어가 없을 경우 에러 발생
	 */
	public async delete(storeName: string, key: string): Promise<void> {
		// 스토어 메타데이터와 key 맵 가져오기
		const storeMeta = this.getStoreMetadata(storeName);
		const keyMap = this.getKeyMap(storeName);

		// 활성화된 행 메타데이터 찾기
		const rowMetadata = this.findActiveRowMetadata(
			keyMap,
			key,
			storeMeta.rows
		);
		if (!rowMetadata) {
			return;
		}

		// 행 데이터를 덮어쓸 용도로 0으로 채운 ArrayBuffer 생성(선택 사항)
		const zeroedArrayBuffer = new ArrayBuffer(rowMetadata.length);
		const zeroedView = new Uint8Array(zeroedArrayBuffer);
		zeroedView.fill(0); // 실제 삭제(덮어쓰기)를 위해 0으로 채움

		// 삭제 작업을 pendingWrites에 추가
		this.pendingWrites.push({
			storeMeta,
			rowMetadata,
			arrayBuffer: zeroedArrayBuffer,
			gpuBuffer: this.getBufferByIndex(
				storeMeta,
				rowMetadata.bufferIndex
			),
			operationType: "delete",
			key, // flush 시 메타데이터 업데이트에 필요
		});

		// flush 타이머 리셋
		this.resetFlushTimer();

		// 배치 크기 초과 확인
		await this.checkAndFlush();
	}

	/**
	 * 지정된 오브젝트 스토어의 모든 행을 제거하고, 모든 GPU 버퍼를 파괴한다.
	 * 그 후, 새 버퍼를 하나 만들어서 사용한다.
	 *
	 * @param {string} storeName - 초기화할 스토어 이름
	 * @returns {void}
	 * @throws {Error} 스토어가 존재하지 않을 경우 에러 발생
	 */
	public async clear(storeName: string): Promise<void> {
		const storeMeta = this.storeMetadataMap.get(storeName);
		if (!storeMeta) {
			throw new Error(`Object store "${storeName}" does not exist.`);
		}

		await this.waitUntilReady();

		// 스토어 메타데이터와 keyMap 가져오기
		const keyMap = this.getKeyMap(storeName);

		// 모든 행 메타데이터 삭제
		storeMeta.rows = [];

		// 기존 GPU 버퍼 파괴
		for (const bufferMeta of storeMeta.buffers) {
			if (bufferMeta.gpuBuffer) {
				bufferMeta.gpuBuffer.destroy();
			}
		}

		// 버퍼 목록 비우기
		storeMeta.buffers = [];

		const newGpuBuffer = this.device.createBuffer({
			size: storeMeta.bufferSize,
			usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
			mappedAtCreation: false,
		});

		// 새로 만든 버퍼 추가
		storeMeta.buffers.push({
			bufferIndex: 0,
			startRow: -1,
			rowCount: 0,
			gpuBuffer: newGpuBuffer,
		});

		// keyMap 초기화
		keyMap.clear();
	}

	/**
	 * 지정된 스토어에서 커서를 열어 레코드를 순회한다.
	 *
	 * @param {string} storeName - 커서를 열 스토어 이름
	 * @param {{
	 *   range?: {
	 *     lowerBound?: string;
	 *     upperBound?: string;
	 *     lowerInclusive?: boolean;
	 *     upperInclusive?: boolean;
	 *   };
	 *   direction?: 'next' | 'prev';
	 * }} [options] - 순회 시 필터링과 방향 제어를 위한 옵션
	 * @returns {AsyncGenerator<{ key: string; value: any }, void, unknown>} 키와 값을 yield하는 비동기 제너레이터
	 * @throws {Error} 스토어가 존재하지 않을 경우 에러 발생
	 *
	 * @example
	 * for await (const record of VramDataBase.openCursor('MyStore')) {
	 *     console.info(record.key, record.value);
	 * }
	 *
	 * @example
	 * const range = { lowerBound: '100', upperBound: '200', lowerInclusive: true, upperInclusive: false };
	 * for await (const record of VramDataBase.openCursor('MyStore', { range, direction: 'prev' })) {
	 *     console.info(record.key, record.value);
	 * }
	 */
	public async *openCursor(
		storeName: string,
		options?: {
			range?: {
				lowerBound?: string;
				upperBound?: string;
				lowerInclusive?: boolean;
				upperInclusive?: boolean;
			};
			direction?: "next" | "prev";
		}
	): AsyncGenerator<{ key: string; value: any }, void, unknown> {
		const storeMeta = this.storeMetadataMap.get(storeName);
		if (!storeMeta) {
			throw new Error(`Object store "${storeName}" does not exist.`);
		}

		// 스토어 메타데이터와 keyMap 가져오기
		const keyMap = this.getKeyMap(storeName);

		// 활성화된 모든 키 가져오기
		let activeKeys = Array.from(keyMap.keys());

		// range가 있다면 키 범위를 필터링
		if (options?.range) {
			activeKeys = this.applyCustomRange(activeKeys, options.range);
		}

		// direction별로 정렬
		if (options?.direction === "prev") {
			activeKeys.sort((a, b) => compareKeys(b, a));
		} else {
			// 기본은 'next'
			activeKeys.sort((a, b) => compareKeys(a, b));
		}

		// 정렬되고 필터링된 키들을 순회하며 레코드를 yield
		for (const key of activeKeys) {
			const rowMetadata = keyMap.get(key);
			if (rowMetadata == null) {
				continue;
			}

			const record = await this.get(storeName, key);
			if (record !== null) {
				yield { key, value: record };
			}
		}
	}

	/**
	 * 대기 중인 쓰기가 임계치에 도달했거나, 다른 조건으로 인해 flush가 필요하면 flush를 수행한다.
	 *
	 * @private
	 * @returns {Promise<void>} 만약 flush가 트리거되면 완료될 때 resolve
	 */
	private async checkAndFlush(): Promise<void> {
		if (this.pendingWrites.length >= this.BATCH_SIZE) {
			if (this.flushTimer !== null) {
				clearTimeout(this.flushTimer);
				this.flushTimer = null;
			}
			// 여기서 flush 완료를 대기
			await this.flushWrites();
		}
	}

	/**
	 * 대기 중인 모든 쓰기를 버퍼별로 모아 한 번에 GPU 버퍼에 기록한다.
	 * 이후 GPU 완료를 대기한다.
	 *
	 * @private
	 * @returns {Promise<void>} 모든 쓰기가 제출되고 큐가 완료되면 resolve
	 */
	private async flushWrites(): Promise<void> {
		if (this.pendingWrites.length === 0) {
			return;
		}

		// pendingWrites를 GPUBuffer 기준으로 그룹화한다
		const writesByBuffer: Map<GPUBuffer, PendingWrite[]> = new Map();
		for (const item of this.pendingWrites) {
			const { gpuBuffer } = item;
			if (!writesByBuffer.has(gpuBuffer)) {
				writesByBuffer.set(gpuBuffer, []);
			}
			writesByBuffer.get(gpuBuffer)!.push(item);
		}

		// 성공적으로 기록된 쓰기를 추적
		const successfulWrites = new Set<PendingWrite>();

		// offset 기준 오름차순으로 정렬 후 한 그룹씩 기록
		for (const [gpuBuffer, writeGroup] of writesByBuffer.entries()) {
			writeGroup.sort(
				(a, b) => a.rowMetadata.offset - b.rowMetadata.offset
			);

			for (const pendingWrite of writeGroup) {
				try {
					const { rowMetadata, arrayBuffer } = pendingWrite;
					this.device.queue.writeBuffer(
						gpuBuffer,
						rowMetadata.offset,
						arrayBuffer
					);
					successfulWrites.add(pendingWrite);
				} catch (singleWriteError) {
					console.error(
						"Error writing single item:",
						singleWriteError
					);
				}
			}
		}

		// GPU 큐 작업 완료 대기
		await this.device.queue.onSubmittedWorkDone();

		// 성공적으로 기록된 항목은 pendingWrites에서 제거
		this.pendingWrites = this.pendingWrites.filter(
			(write) => !successfulWrites.has(write)
		);
	}

	/**
	 * 사용자 정의 문자열 키 범위(lower/upper, inclusivity 등)를 적용해 배열의 키를 필터링한다.
	 *
	 * @private
	 * @param {string[]} keys - 필터링할 키들
	 * @param {{
	 *   lowerBound?: string;
	 *   upperBound?: string;
	 *   lowerInclusive?: boolean;
	 *   upperInclusive?: boolean;
	 * }} range - 범위와 포함 여부 설정
	 * @returns {string[]} 범위 조건을 충족하는 키들의 배열
	 */
	private applyCustomRange(
		keys: string[],
		range: {
			lowerBound?: string;
			upperBound?: string;
			lowerInclusive?: boolean;
			upperInclusive?: boolean;
		}
	): string[] {
		return keys.filter((key) => {
			let withinLower = true;
			let withinUpper = true;

			if (range.lowerBound !== undefined) {
				if (range.lowerInclusive) {
					withinLower = key >= range.lowerBound;
				} else {
					withinLower = key > range.lowerBound;
				}
			}

			if (range.upperBound !== undefined) {
				if (range.upperInclusive) {
					withinUpper = key <= range.upperBound;
				} else {
					withinUpper = key < range.upperBound;
				}
			}

			return withinLower && withinUpper;
		});
	}

	/**
	 * 지정된 스토어 이름에 대한 keyMap을 가져온다.
	 *
	 * @private
	 * @param {string} storeName - 스토어 이름
	 * @returns {Map<string, number>} 해당 스토어의 키 맵
	 * @throws {Error} 스토어가 없으면 새 맵을 반환(혹은 에러)
	 */
	private getKeyMap(storeName: string): Map<string, number> {
		const keyMap = this.storeKeyMap.get(storeName);
		if (!keyMap) {
			return new Map<string, number>();
		}
		return keyMap;
	}

	/**
	 * 주어진 키에 대한 활성화된 행 메타데이터를 찾는다(비활성 플래그가 아니어야 함).
	 *
	 * @private
	 * @param {Map<string, number>} keyMap - 키 → 행 ID 매핑
	 * @param {string} key - 찾을 키
	 * @param {RowMetadata[]} rows - 해당 스토어의 행 메타데이터 목록
	 * @returns {RowMetadata | null} 찾고 활성화된 메타데이터, 없으면 null
	 */
	private findActiveRowMetadata(
		keyMap: Map<string, number>,
		key: string,
		rows: RowMetadata[]
	): RowMetadata | null {
		const rowId = keyMap.get(key);
		if (rowId == null) {
			return null;
		}
		const rowMetadata = rows.find((r) => r.rowId === rowId);
		if (!rowMetadata) {
			return null;
		}
		if ((rowMetadata.flags ?? 0) & ROW_INACTIVE_FLAG) {
			return null;
		}
		return rowMetadata;
	}

	/**
	 * 스토어 이름으로 메타데이터 객체를 가져온다.
	 *
	 * @private
	 * @param {string} storeName - 스토어 이름
	 * @returns {StoreMetadata} 해당 스토어의 메타데이터
	 * @throws {Error} 스토어가 없으면 에러
	 */
	private getStoreMetadata(storeName: string): StoreMetadata {
		const meta = this.storeMetadataMap.get(storeName);
		if (!meta) {
			throw new Error(`Object store "${storeName}" does not exist.`);
		}
		return meta;
	}

	/**
	 * 주어진 크기에 맞춰 이미 존재하는 GPU 버퍼에서 공간을 찾거나, 새로운 버퍼를 할당해 준다.
	 * GPU 버퍼 참조, 인덱스, 그리고 쓰기 오프셋을 반환한다.
	 *
	 * @private
	 * @param {StoreMetadata} storeMeta - 스토어 메타데이터
	 * @param {number} size - 필요한 바이트 크기
	 * @returns {{ gpuBuffer: GPUBuffer; bufferIndex: number; offset: number }}
	 *  선택된 GPU 버퍼와 해당 버퍼 인덱스, 그리고 쓸 위치 오프셋
	 */
	findOrCreateSpace(
		storeMeta: StoreMetadata,
		size: number
	): {
		gpuBuffer: GPUBuffer;
		bufferIndex: number;
		offset: number;
	} {
		if (storeMeta.buffers.length === 0) {
			// 버퍼가 아직 없으면 첫 버퍼를 생성
			return this.allocateFirstBufferChunk(storeMeta, size);
		}

		// 그렇지 않다면 마지막 버퍼에 남은 공간이 있는지 확인
		const { lastBufferMeta, usedBytes } =
			this.getLastBufferUsage(storeMeta);
		const capacity = storeMeta.bufferSize;

		if (usedBytes + size <= capacity) {
			// 마지막 버퍼에 공간이 충분
			return this.useSpaceInLastBuffer(
				storeMeta,
				lastBufferMeta,
				usedBytes,
				size
			);
		}

		// 공간이 부족하므로 새 버퍼를 할당
		return this.allocateNewBufferChunk(storeMeta, size);
	}

	/**
	 * 새 GPU 버퍼를 생성하여 반환한다.
	 *
	 * @private
	 * @param {StoreMetadata} storeMeta - 새 GPU 버퍼를 필요한 스토어 메타데이터
	 * @param {number} size - 요청된 크기(대개 storeMeta.bufferSize에 해당)
	 * @returns {GPUBuffer} 새로 생성된 GPU 버퍼
	 */
	private createNewBuffer(storeMeta: StoreMetadata, size: number): GPUBuffer {
		return this.device.createBuffer({
			size: storeMeta.bufferSize,
			usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
			mappedAtCreation: false,
		});
	}

	/**
	 * 스토어에 가장 처음 버퍼를 할당하고 초기화한다.
	 * 필요한 크기가 storeMeta.bufferSize보다 큰 경우, 동적으로 버퍼 크기를 확장한다.
	 *
	 * @private
	 * @param {StoreMetadata} storeMeta - 버퍼가 생길 스토어 메타데이터
	 * @param {number} size - 첫 버퍼에 필요한 바이트 수
	 * @returns {{ gpuBuffer: GPUBuffer; bufferIndex: number; offset: number }}
	 *   새 GPU 버퍼, 버퍼 인덱스, 오프셋(항상 0)
	 */
	private allocateFirstBufferChunk(
		storeMeta: StoreMetadata,
		size: number
	): {
		gpuBuffer: GPUBuffer;
		bufferIndex: number;
		offset: number;
	} {
		// 필요한 용량 계산
		const neededCapacity = Math.max(
			storeMeta.bufferSize,
			roundUp(size, 256)
		);
		const gpuBuffer = this.device.createBuffer({
			size: neededCapacity,
			usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
			mappedAtCreation: false,
		});
		(gpuBuffer as any)._usedBytes = 0;

		storeMeta.buffers.push({
			bufferIndex: 0,
			startRow: -1,
			rowCount: 0,
			gpuBuffer,
		});

		(gpuBuffer as any)._usedBytes = size;
		storeMeta.buffers[0].rowCount += 1;

		return {
			gpuBuffer,
			bufferIndex: 0,
			offset: 0,
		};
	}

	/**
	 * 스토어에서 마지막 버퍼의 사용량을 가져온다(메타데이터와 바이트 사용량).
	 *
	 * @private
	 * @param {StoreMetadata} storeMeta - 버퍼 목록이 있는 스토어 메타데이터
	 * @returns {{ lastBufferMeta: BufferMetadata; usedBytes: number }}
	 *   마지막 버퍼의 메타데이터와 이미 사용된 바이트 수
	 */
	private getLastBufferUsage(storeMeta: StoreMetadata): {
		lastBufferMeta: BufferMetadata;
		usedBytes: number;
	} {
		const lastIndex = storeMeta.buffers.length - 1;
		const lastBufferMeta = storeMeta.buffers[lastIndex];
		const gpuBuffer = lastBufferMeta.gpuBuffer!;
		const usedBytes = (gpuBuffer as any)._usedBytes || 0;
		return { lastBufferMeta, usedBytes };
	}

	/**
	 * 마지막 버퍼에 공간이 남아 있다면 해당 공간을 사용한다(정렬 고려).
	 * 정렬(256 바이트 맞춤)로 인해 공간이 부족해지면, 새 버퍼를 할당한다.
	 *
	 * @private
	 * @param {StoreMetadata} storeMeta - 스토어 메타데이터
	 * @param {BufferMetadata} lastBufferMeta - 마지막 GPU 버퍼 메타데이터
	 * @param {number} usedBytes - 이미 사용된 바이트 수
	 * @param {number} size - 필요한 바이트
	 * @returns {{ gpuBuffer: GPUBuffer; bufferIndex: number; offset: number }}
	 *   버퍼, 버퍼 인덱스, 새로 할당된 오프셋
	 */
	private useSpaceInLastBuffer(
		storeMeta: StoreMetadata,
		lastBufferMeta: BufferMetadata,
		usedBytes: number,
		size: number
	): {
		gpuBuffer: GPUBuffer;
		bufferIndex: number;
		offset: number;
	} {
		const gpuBuffer = lastBufferMeta.gpuBuffer!;
		const ALIGNMENT = 256;

		// 오프셋을 256 배수로 정렬
		const alignedOffset = roundUp(usedBytes, ALIGNMENT);

		// 정렬된 오프셋 + size가 버퍼 용량을 초과하면 새 버퍼 할당
		if (alignedOffset + size > gpuBuffer.size) {
			return this.allocateNewBufferChunk(storeMeta, size);
		}

		(gpuBuffer as any)._usedBytes = alignedOffset + size;
		lastBufferMeta.rowCount += 1;

		const bufferIndex = lastBufferMeta.bufferIndex;
		return {
			gpuBuffer,
			bufferIndex,
			offset: alignedOffset,
		};
	}

	/**
	 * 마지막 버퍼가 공간이 부족할 경우 새 GPU 버퍼를 할당한다.
	 * 필요한 크기가 storeMeta.bufferSize보다 큰 경우, 동적으로 크기를 확장한다.
	 *
	 * @private
	 * @param {StoreMetadata} storeMeta - 버퍼를 생성할 스토어 메타데이터
	 * @param {number} size - 필요한 바이트 수
	 * @returns {{ gpuBuffer: GPUBuffer; bufferIndex: number; offset: number }}
	 *   새로 만든 버퍼와 인덱스, 오프셋(0)
	 */
	private allocateNewBufferChunk(
		storeMeta: StoreMetadata,
		size: number
	): {
		gpuBuffer: GPUBuffer;
		bufferIndex: number;
		offset: number;
	} {
		const newBufferIndex = storeMeta.buffers.length;

		// 필요한 용량 계산
		const neededCapacity = Math.max(
			storeMeta.bufferSize,
			roundUp(size, 256)
		);
		const newGpuBuffer = this.device.createBuffer({
			size: neededCapacity,
			usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
			mappedAtCreation: false,
		});

		(newGpuBuffer as any)._usedBytes = size;
		storeMeta.buffers.push({
			bufferIndex: newBufferIndex,
			startRow: -1,
			rowCount: 1,
			gpuBuffer: newGpuBuffer,
		});

		return {
			gpuBuffer: newGpuBuffer,
			bufferIndex: newBufferIndex,
			offset: 0,
		};
	}

	/**
	 * 값(JSON, TypedArray, ArrayBuffer 등)을 GPU 버퍼에 기록하기 적합한 ArrayBuffer로 직렬화한다.
	 *
	 * @private
	 * @param {StoreMetadata} storeMeta - 쓰려는 스토어 메타데이터
	 * @param {any} value - 원본 값
	 * @returns {ArrayBuffer} GPU에 기록하기 위한 직렬화된 버퍼
	 */
	private serializeValueForStore(
		storeMeta: StoreMetadata,
		value: any
	): ArrayBuffer {
		let resultBuffer: ArrayBuffer;

		switch (storeMeta.dataType) {
			case "JSON": {
				let jsonString = JSON.stringify(value);
				jsonString = padJsonTo4Bytes(jsonString);
				const cloned = new TextEncoder().encode(jsonString).slice();
				resultBuffer = cloned.buffer;
				break;
			}

			case "TypedArray": {
				if (!storeMeta.typedArrayType) {
					throw new Error(
						`typedArrayType is missing for store "${storeMeta}".`
					);
				}
				if (!(value instanceof globalThis[storeMeta.typedArrayType])) {
					throw new Error(
						`Value must be an instance of ${storeMeta.typedArrayType} for store "${storeMeta}".`
					);
				}
				resultBuffer = (value as { buffer: ArrayBuffer }).buffer;
				break;
			}

			case "ArrayBuffer": {
				if (!(value instanceof ArrayBuffer)) {
					throw new Error(
						`Value must be an ArrayBuffer for store "${storeMeta}".`
					);
				}
				resultBuffer = value;
				break;
			}

			default:
				throw new Error(`Unknown dataType "${storeMeta.dataType}".`);
		}

		// *** 마지막으로, WebGPU를 위해 4바이트 정렬을 맞춘다. ***
		return padTo4Bytes(resultBuffer);
	}

	/**
	 * 주어진 키에 대한 기존 행 메타데이터를 찾고, 없으면 새로 만든다.
	 *
	 * @private
	 * @param {StoreMetadata} storeMeta - 스토어 메타데이터
	 * @param {Map<string, number>} keyMap - 키 → 행 인덱스 매핑
	 * @param {string} key - 고유 키
	 * @param {ArrayBuffer} arrayBuffer - 이 행에 할당할 데이터
	 * @param {"add"|"put"} operationType - 어떤 작업인지(add인지 put인지)
	 * @returns {Promise<RowMetadata>} 행 메타데이터
	 */
	private async findOrCreateRowMetadata(
		storeMeta: StoreMetadata,
		keyMap: Map<string, number>,
		key: string,
		arrayBuffer: ArrayBuffer,
		mode: "add" | "put"
	): Promise<RowMetadata> {
		let rowId = keyMap.get(key);
		let rowMetadata =
			rowId == null
				? null
				: storeMeta.rows.find((r) => r.rowId === rowId) || null;

		// 이미 활성화된 행이 있는데 모드가 "add"이면, 덮어쓰기를 허용하지 않음
		if (
			mode === "add" &&
			rowMetadata &&
			!((rowMetadata.flags ?? 0) & ROW_INACTIVE_FLAG)
		) {
			throw new Error(
				`Record with key "${key}" already exists in store and overwriting is not allowed (add mode).`
			);
		}

		// GPU 버퍼에서 공간 할당(오프셋, 버퍼인덱스 결정)
		const { gpuBuffer, bufferIndex, offset } = this.findOrCreateSpace(
			storeMeta,
			arrayBuffer.byteLength
		);

		// 새 행이거나 비활성화된 행이면, 새로운 RowMetadata 생성
		if (!rowMetadata || (rowMetadata.flags ?? 0) & ROW_INACTIVE_FLAG) {
			rowId = storeMeta.rows.length + 1;
			rowMetadata = {
				rowId,
				bufferIndex,
				offset,
				length: arrayBuffer.byteLength,
			};
			storeMeta.rows.push(rowMetadata);
			keyMap.set(key, rowId);
		}
		// 활성화된 행이 있고 모드가 "put"이라면, 재할당 가능성 고려
		else if (mode === "put") {
			rowMetadata = await this.updateRowOnOverwrite(
				storeMeta,
				rowMetadata,
				arrayBuffer,
				keyMap,
				key
			);
		}

		return rowMetadata;
	}

	/**
	 * 새 데이터가 기존 할당보다 크면 이전 행을 비활성화하고 새 버퍼 공간을 할당한다.
	 * 크기가 충분하면 자리만 업데이트하여 재기록한다.
	 *
	 * @private
	 * @param {StoreMetadata} storeMeta - 스토어 메타데이터
	 * @param {RowMetadata} oldRowMeta - 기존 행 메타데이터
	 * @param {ArrayBuffer} arrayBuffer - 새 데이터
	 * @param {Map<string, number>} keyMap - 키 → 행 인덱스 매핑
	 * @param {string} key - 덮어쓸 행의 키
	 * @returns {Promise<RowMetadata>} 새롭게 생성되었거나 갱신된 행 메타데이터
	 */
	private async updateRowOnOverwrite(
		storeMeta: StoreMetadata,
		oldRowMeta: RowMetadata,
		arrayBuffer: ArrayBuffer,
		keyMap: Map<string, number>,
		key: string
	): Promise<RowMetadata> {
		// 새 데이터가 기존 공간에 들어갈 수 있으면 그대로 재기록
		if (arrayBuffer.byteLength <= oldRowMeta.length) {
			// flushWrites 중에 덮어쓰기
			if (arrayBuffer.byteLength < oldRowMeta.length) {
				oldRowMeta.length = arrayBuffer.byteLength;
			}
			return oldRowMeta;
		} else {
			// 기존 행 비활성화
			oldRowMeta.flags = (oldRowMeta.flags ?? 0) | ROW_INACTIVE_FLAG;

			// 더 큰 데이터에 맞는 새 공간 확보
			const { gpuBuffer, bufferIndex, offset } = this.findOrCreateSpace(
				storeMeta,
				arrayBuffer.byteLength
			);

			const newRowId = storeMeta.rows.length + 1;
			const newRowMeta: RowMetadata = {
				rowId: newRowId,
				bufferIndex,
				offset,
				length: arrayBuffer.byteLength,
			};
			storeMeta.rows.push(newRowMeta);
			keyMap.set(key, newRowId);

			return newRowMeta;
		}
	}

	/**
	 * GPU 버퍼에서 읽은 원시 바이트 데이터를 (JSON, TypedArray, ArrayBuffer 등) 원래 형태로 역직렬화한다.
	 *
	 * @private
	 * @param {StoreMetadata} storeMeta - 스토어 메타데이터( dataType, typedArrayType 등)
	 * @param {Uint8Array} copiedData - GPU에서 복사된 원시 바이트 배열
	 * @returns {any} 역직렬화 결과 (storeMeta.dataType에 따라 달라짐)
	 * @throws {Error} 지원되지 않는 dataType 또는 typedArrayType이면 에러
	 */
	private deserializeData(
		storeMeta: StoreMetadata,
		copiedData: Uint8Array
	): any {
		switch (storeMeta.dataType) {
			case "JSON": {
				const jsonString = new TextDecoder().decode(copiedData);
				return JSON.parse(jsonString.trim());
			}

			case "TypedArray": {
				if (!storeMeta.typedArrayType) {
					throw new Error(
						`typedArrayType is missing for store with dataType "TypedArray".`
					);
				}
				const TypedArrayCtor = (globalThis as any)[
					storeMeta.typedArrayType
				];
				if (typeof TypedArrayCtor !== "function") {
					throw new Error(
						`Invalid typedArrayType "${storeMeta.typedArrayType}".`
					);
				}

				// 서브어레이의 offset/length를 올바르게 처리
				const bytesPerElement = this.getBytesPerElement(
					storeMeta.typedArrayType
				);
				return new TypedArrayCtor(
					copiedData.buffer,
					copiedData.byteOffset,
					copiedData.byteLength / bytesPerElement
				);
			}

			case "ArrayBuffer": {
				return copiedData.buffer;
			}

			default:
				throw new Error(`Unknown dataType "${storeMeta.dataType}".`);
		}
	}

	/**
	 * 주어진 typedArrayType 이름에 대해 엘리먼트 하나가 차지하는 바이트 수를 반환한다.
	 *
	 * @private
	 * @param {string} typedArrayType - 예: "Float32Array"
	 * @returns {number} 엘리먼트 1개가 차지하는 바이트 수
	 * @throws {Error} 미지원 typedArrayType일 경우
	 */
	private getBytesPerElement(typedArrayType: string): number {
		switch (typedArrayType) {
			case "Float32Array":
			case "Int32Array":
			case "Uint32Array":
				return 4;
			case "Float64Array":
				return 8;
			case "Uint8Array":
				return 1;
			default:
				throw new Error(
					`Unsupported typedArrayType: ${typedArrayType}`
				);
		}
	}

	/**
	 * 버퍼 인덱스에 해당하는 GPUBuffer 인스턴스를 가져온다.
	 *
	 * @private
	 * @param {StoreMetadata} storeMeta - 스토어 메타데이터
	 * @param {number} bufferIndex - 가져올 버퍼 인덱스
	 * @returns {GPUBuffer} 해당 인덱스의 GPU 버퍼
	 */
	private getBufferByIndex(
		storeMeta: StoreMetadata,
		bufferIndex: number
	): GPUBuffer {
		const bufMeta = storeMeta.buffers[bufferIndex];
		if (!bufMeta || !bufMeta.gpuBuffer) {
			throw new Error(
				`Buffer index ${bufferIndex} not found or uninitialized.`
			);
		}
		return bufMeta.gpuBuffer;
	}

	/**
	 * pendingWrites를 자동으로 flush하기 위한 타이머를 리셋한다.
	 * 만약 이미 타이머가 동작 중이라면, 타이머를 지우고 다시 시작한다.
	 * 타이머가 동작하면 다음을 수행:
	 *  1) 모든 pendingWrites flush
	 *  2) `rebuildAllDirtySorts`를 호출하여 정렬 재빌드
	 *  3) 내부 `readyResolver`가 있다면 이를 resolve
	 *  4) `isReady`를 true로 설정
	 *
	 * @private
	 * @returns {void}
	 */
	private resetFlushTimer(): void {
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer);
		}
		this.flushTimer = window.setTimeout(async () => {
			try {
				await this.flushWrites();
				await this.rebuildAllDirtySorts();
				this.dateParseCache = new Map<string, number>();
				this.stringCache = new Map<string, Uint32Array>();
			} catch (error) {
				console.error("Error during timed flush operation:", error);
			} finally {
				this.flushTimer = null;

				if (this.readyResolver) {
					this.readyResolver();
					this.readyResolver = null;
					this.waitUntilReadyPromise = null;
				}

				this.isReady = true;
			}
		}, 250);
	}

	/**
	 * 모든 스토어 중 `sortsDirty = true` 인 곳의 정렬을 재구성한다.
	 * 각 스토어에 대해, `sortDefinition`을 순회하며 정렬을 재빌드한다.
	 *
	 * 이제 JSON에 대해서는 각 행별 숫자 데이터를 offsets 스토어에 저장하므로,
	 * GPU 버퍼를 사용해 정렬을 수행할 수 있도록 이 숫자 데이터를 모아서 정렬을 진행한다.
	 *
	 * @private
	 * @returns {Promise<void>} 모든 정렬 재빌드가 끝나면 resolve
	 */
	private async rebuildAllDirtySorts(gpuSort?: boolean): Promise<void> {
		for (const [storeName, storeMeta] of this.storeMetadataMap.entries()) {
			if (!storeMeta.sortsDirty) {
				continue;
			}
			storeMeta.sortsDirty = false; // 더티 플래그 리셋

			// 정렬 정의가 없다면 스킵
			if (
				!storeMeta.sortDefinition ||
				storeMeta.sortDefinition.length === 0
			) {
				continue;
			}

			// 각 정의에 대해 순차적으로 재빌드
			// (실제 GPU 정렬 함수는 생략됨. 필요시 아래 runGpuSortForDefinition 로직 참조)
			if (gpuSort) {
				for (const def of storeMeta.sortDefinition) {
					await this.runGpuSortForDefinition(storeMeta, def);
				}
			}
		}
	}

	/**
	 * 대기 중인 모든 쓰기를 flush한 뒤, 해당 스토어 메타데이터와 keyMap을 반환한다.
	 *
	 * @private
	 * @param {string} storeName - 스토어 이름
	 * @returns {Promise<{ storeMeta: StoreMetadata; keyMap: Map<string, number>; metrics: InitialMetrics }>}
	 *    flush 후 스토어의 메타데이터와 keyMap, 그리고 간단한 측정값
	 */
	private async flushAndGetMetadata(storeName: string): Promise<{
		storeMeta: StoreMetadata;
		keyMap: Map<string, any>;
		metrics: InitialMetrics;
	}> {
		const performanceMetrics: InitialMetrics = {
			flushWrites: 0,
			metadataRetrieval: 0,
		};

		const flushStart = performance.now();
		await this.flushWrites();
		performanceMetrics.flushWrites = performance.now() - flushStart;

		const metadataStart = performance.now();
		const storeMeta = this.getStoreMetadata(storeName) as StoreMetadata;
		const keyMap = this.getKeyMap(storeName) as Map<string, any>;
		performanceMetrics.metadataRetrieval =
			performance.now() - metadataStart;

		return { storeMeta, keyMap, metrics: performanceMetrics };
	}

	/**
	 * (가능한) 와일드카드 키(%, _, [] 등을 포함할 수 있음)를 확장하여
	 * keyMap 내 일치하는 모든 키를 찾는다.
	 *
	 * @private
	 * @param {string} key - (와일드카드) 패턴
	 * @param {Map<string, any>} keyMap - 모든 키가 들어 있는 맵
	 * @returns {string[]} 매칭된 키 배열
	 */
	private expandWildcard(key: string, keyMap: Map<string, any>): string[] {
		if (!/[%_\[\]]/.test(key)) {
			return [key];
		}
		const regex = likeToRegex(key);
		const allStoreKeys = Array.from(keyMap.keys());
		return allStoreKeys.filter((k) => regex.test(k));
	}

	/**
	 * 주어진 키 배열 각각에 대해 expandWildcard를 적용한 후, 결과를 평탄화한다.
	 *
	 * @private
	 * @param {string[]} keys - (와일드카드 포함 가능) 키 배열
	 * @param {Map<string, any>} keyMap - 스토어 키 맵
	 * @returns {string[]} 확장된 키들의 합쳐진 배열
	 */
	private expandAllWildcards(
		keys: string[],
		keyMap: Map<string, any>
	): string[] {
		return keys.flatMap((key) => this.expandWildcard(key, keyMap));
	}

	/**
	 * 키 배열에 대해 행 데이터를 읽는다(두 단계):
	 *  1) 스토어의 GPU 버퍼 여러 개에서 단일 "big read buffer"(bigReadBuffer)로 복사
	 *  2) bigReadBuffer에서 CPU로 매핑된 스테이징 버퍼로 복사 후, 그 데이터를 사용
	 *
	 * @private
	 * @param {string} storeName - 읽을 스토어 이름
	 * @param {StoreMetadata} storeMeta - 스토어 메타데이터
	 * @param {Map<string, any>} keyMap - 키 맵
	 * @param {string[]} keys - 읽을 키들
	 * @returns {Promise<{ results: (any | null)[]; perKeyMetrics: PerKeyMetrics }>}
	 *   - `results`: 역직렬화된 값들(키가 없으면 null)
	 *   - `perKeyMetrics`: 작업 단계별 시간 정보
	 */
	private async readAllRows(
		storeName: string,
		storeMeta: StoreMetadata,
		keyMap: Map<string, any>,
		keys: string[]
	): Promise<{ results: (any | null)[]; perKeyMetrics: PerKeyMetrics }> {
		// 결과 배열(초기 null)
		const results = new Array<any | null>(keys.length).fill(null);

		// 성능 측정 구조체
		const perKeyMetrics: PerKeyMetrics = this.initializeMetrics();

		// 로우 메타데이터 수집
		const { rowInfos, totalBytes } = this.collectRowInfos(
			keyMap,
			storeMeta,
			keys,
			results,
			perKeyMetrics
		);

		// 읽을 게 없다면 조기 반환
		if (rowInfos.length === 0) {
			return { results, perKeyMetrics };
		}

		// (1) bigReadBuffer 생성
		const bigReadBuffer = this.createBigReadBuffer(
			totalBytes,
			perKeyMetrics
		);

		// 스텝 1) 각 행의 GPU 버퍼에서 bigReadBuffer로 복사
		this.copyRowsIntoBigBuffer(
			rowInfos,
			storeMeta,
			bigReadBuffer,
			perKeyMetrics
		);

		// 스텝 2) bigReadBuffer에서 스테이징 버퍼로 복사 후 매핑
		const bigCopiedData = await this.copyFromBigBufferToStaging(
			bigReadBuffer,
			totalBytes,
			perKeyMetrics
		);

		// 각 행 역직렬화
		this.deserializeRows(
			rowInfos,
			storeMeta,
			bigCopiedData,
			results,
			perKeyMetrics
		);

		// bigReadBuffer 해제
		bigReadBuffer.destroy();

		return { results, perKeyMetrics };
	}

	/**
	 * (키, 로우 인덱스) 목록을 만들어, 몇 바이트가 필요한지 계산한다.
	 *
	 * @private
	 * @param {Map<string, any>} keyMap - 키 맵
	 * @param {StoreMetadata} storeMeta - 스토어 메타데이터
	 * @param {string[]} keys - 요청된 키 목록
	 * @param {(any | null)[]} results - 결과 배열
	 * @param {PerKeyMetrics} perKeyMetrics - 측정값
	 * @returns {{ rowInfos: RowInfo[], totalBytes: number }}
	 */
	private collectRowInfos(
		keyMap: Map<string, any>,
		storeMeta: StoreMetadata,
		keys: string[],
		results: (any | null)[],
		perKeyMetrics: PerKeyMetrics
	): { rowInfos: RowInfo[]; totalBytes: number } {
		const findMetadataStart = performance.now();

		const rowInfos: RowInfo[] = [];
		let totalBytes = 0;

		for (let i = 0; i < keys.length; i++) {
			const key = keys[i];
			const rowMetadata = this.findActiveRowMetadata(
				keyMap,
				key,
				storeMeta.rows
			);
			if (!rowMetadata) {
				continue;
			}
			rowInfos.push({
				rowMetadata,
				rowIndex: i,
				offsetInFinalBuffer: totalBytes,
				length: rowMetadata.length,
			});
			totalBytes += rowMetadata.length;
		}

		perKeyMetrics.findMetadata = performance.now() - findMetadataStart;

		return { rowInfos, totalBytes };
	}

	/**
	 * 주어진 totalBytes 크기를 가지는 GPU 버퍼를 생성하여 "big read buffer"로 사용한다.
	 *
	 * @private
	 * @param {number} totalBytes - 필요한 총 바이트
	 * @param {PerKeyMetrics} perKeyMetrics - 측정값
	 * @returns {GPUBuffer} 새로 생성된 GPU 버퍼
	 */
	private createBigReadBuffer(
		totalBytes: number,
		perKeyMetrics: PerKeyMetrics
	): GPUBuffer {
		const createBufferStart = performance.now();

		const bigReadBuffer = this.device.createBuffer({
			size: totalBytes,
			usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, // MAP_READ 대신 COPY_DST 사용
		});

		perKeyMetrics.createBuffer = performance.now() - createBufferStart;
		return bigReadBuffer;
	}

	/**
	 * rowInfos에 담긴 각 행에 대해,
	 * 해당 GPU 버퍼 → bigReadBuffer로 복사하는 명령을 생성하여 제출한다.
	 *
	 * @private
	 * @param {RowInfo[]} rowInfos - 행 메타데이터(오프셋, 길이 등)
	 * @param {StoreMetadata} storeMeta - 스토어 메타데이터
	 * @param {GPUBuffer} bigReadBuffer - 최종 병합 버퍼
	 * @param {PerKeyMetrics} perKeyMetrics - 측정값
	 * @returns {void}
	 */
	private copyRowsIntoBigBuffer(
		rowInfos: RowInfo[],
		storeMeta: StoreMetadata,
		bigReadBuffer: GPUBuffer,
		perKeyMetrics: PerKeyMetrics
	): void {
		const copyBufferStart = performance.now();

		const commandEncoder = this.device.createCommandEncoder();

		for (const rowInfo of rowInfos) {
			const srcBuffer = this.getBufferByIndex(
				storeMeta,
				rowInfo.rowMetadata.bufferIndex
			);
			commandEncoder.copyBufferToBuffer(
				srcBuffer,
				rowInfo.rowMetadata.offset,
				bigReadBuffer,
				rowInfo.offsetInFinalBuffer,
				rowInfo.length
			);
		}

		this.device.queue.submit([commandEncoder.finish()]);

		perKeyMetrics.copyBuffer = performance.now() - copyBufferStart;
	}

	/**
	 * bigReadBuffer → 스테이징 버퍼(MAP_READ 사용) → CPU로 매핑 후 Uint8Array로 복사해 반환.
	 *
	 * @private
	 * @param {GPUBuffer} bigReadBuffer - 합쳐진 데이터가 들어있는 버퍼
	 * @param {number} totalBytes - 복사해야 할 총 바이트
	 * @param {PerKeyMetrics} perKeyMetrics - 측정값
	 * @returns {Promise<Uint8Array>} 모든 데이터를 담고 있는 Uint8Array
	 */
	private async copyFromBigBufferToStaging(
		bigReadBuffer: GPUBuffer,
		totalBytes: number,
		perKeyMetrics: PerKeyMetrics
	): Promise<Uint8Array> {
		const mapBufferStart = performance.now();

		// 1) COPY_DST | MAP_READ 용 스테이징 버퍼 생성
		const stagingBuffer = this.device.createBuffer({
			size: totalBytes,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		});

		// 2) bigReadBuffer → stagingBuffer 복사
		const commandEncoder = this.device.createCommandEncoder();
		commandEncoder.copyBufferToBuffer(
			bigReadBuffer,
			0,
			stagingBuffer,
			0,
			totalBytes
		);
		this.device.queue.submit([commandEncoder.finish()]);

		// GPU 작업 완료 대기
		await this.device.queue.onSubmittedWorkDone();

		// 스테이징 버퍼 매핑
		const mapAsyncStart = performance.now();
		await stagingBuffer.mapAsync(GPUMapMode.READ);
		perKeyMetrics.mapBufferSubsections.mapAsync =
			performance.now() - mapAsyncStart;

		// getMappedRange
		const getMappedRangeStart = performance.now();
		const fullMappedRange = stagingBuffer.getMappedRange();
		perKeyMetrics.mapBufferSubsections.getMappedRange =
			performance.now() - getMappedRangeStart;

		// copyToUint8Array
		const copyToUint8ArrayStart = performance.now();
		const bigCopiedData = new Uint8Array(fullMappedRange.slice(0));
		perKeyMetrics.mapBufferSubsections.copyToUint8Array =
			performance.now() - copyToUint8ArrayStart;

		// unmap
		const unmapStart = performance.now();
		stagingBuffer.unmap();
		perKeyMetrics.mapBufferSubsections.unmap =
			performance.now() - unmapStart;

		stagingBuffer.destroy();

		perKeyMetrics.mapBuffer = performance.now() - mapBufferStart;

		return bigCopiedData;
	}

	/**
	 * `bigCopiedData`로부터 각 행을 서브어레이로 잘라, 원래 타입(JSON/TypedArray/ArrayBuffer)으로 역직렬화하고
	 * 결과 배열(results)에 저장한다.
	 *
	 * @private
	 * @param {RowInfo[]} rowInfos - 행 메타데이터(오프셋, 길이 등)
	 * @param {StoreMetadata} storeMeta - 스토어 메타데이터
	 * @param {Uint8Array} bigCopiedData - 합쳐진 모든 바이트
	 * @param {(any | null)[]} results - 결과를 저장할 배열
	 * @param {PerKeyMetrics} perKeyMetrics - 측정값
	 * @returns {void}
	 */
	private deserializeRows(
		rowInfos: RowInfo[],
		storeMeta: StoreMetadata,
		bigCopiedData: Uint8Array,
		results: (any | null)[],
		perKeyMetrics: PerKeyMetrics
	): void {
		const deserializeStart = performance.now();

		for (const rowInfo of rowInfos) {
			const rowSlice = bigCopiedData.subarray(
				rowInfo.offsetInFinalBuffer,
				rowInfo.offsetInFinalBuffer + rowInfo.length
			);

			// bytes → 객체
			results[rowInfo.rowIndex] = this.deserializeData(
				storeMeta,
				rowSlice
			);
		}

		perKeyMetrics.deserialize = performance.now() - deserializeStart;
	}

	/**
	 * 각 타이밍 값을 0으로 초기화한 PerKeyMetrics 객체를 생성하여 반환한다.
	 *
	 * @private
	 * @returns {PerKeyMetrics} 초기화된 메트릭 객체
	 */
	private initializeMetrics(): PerKeyMetrics {
		return {
			findMetadata: 0,
			createBuffer: 0,
			copyBuffer: 0,
			mapBuffer: 0,
			deserialize: 0,
			mapBufferSubsections: {
				mapAsync: 0,
				getMappedRange: 0,
				copyToUint8Array: 0,
				unmap: 0,
			},
		};
	}

	/**
	 * VramDataBase가 준비될 때까지 기다린다. 즉, 대기 중인 작업이 모두 끝나고 ready 상태가 될 때까지 대기.
	 *
	 * @private
	 * @returns {Promise<void>} VramDataBase가 ready 상태가 되면 resolve
	 */
	private waitUntilReady(): Promise<void> {
		// 이미 준비됨
		if (this.isReady) return Promise.resolve();

		// 기존에 대기 중인 프라미스가 있으면 그걸 반환
		if (this.waitUntilReadyPromise) return this.waitUntilReadyPromise;

		// 새 프라미스 생성
		this.waitUntilReadyPromise = new Promise<void>((resolve) => {
			this.readyResolver = resolve;
		});

		return this.waitUntilReadyPromise;
	}

	/**
	 * skip/take 페이지네이션 형태로 스토어의 행을 읽는다.
	 *
	 * @private
	 * @param {string} storeName - 스토어 이름
	 * @param {string[]} allKeys - 스토어의 모든 키
	 * @param {number} skip - 스킵할 레코드 수
	 * @param {number} take - 스킵 후 가져올 레코드 수
	 * @returns {Promise<{ results: (any | null)[]; perKeyMetrics: any }>}
	 *    `results` 배열을 포함하는 객체를 resolve
	 */
	private async readRowsWithPagination(
		storeName: string,
		allKeys: any,
		skip: number,
		take: number
	): Promise<{ results: (any | null)[]; perKeyMetrics: any }> {
		// 키 배열 슬라이스
		const paginatedKeys = allKeys.slice(skip, skip + take);

		// getMultipleByKeys로 페치
		const { results, perKeyMetrics } = await this.getMultipleByKeys(
			storeName,
			paginatedKeys
		);

		return { results, perKeyMetrics };
	}

	/**
	 * getMultiple 메서드의 오버로드 버전 중, 키 배열을 인자로 받았을 때 내부적으로 호출되는 메서드.
	 *
	 * @private
	 * @param {string} storeName - 스토어 이름
	 * @param {string[]} keys - 가져올 키 배열
	 * @returns {Promise<{ results: (any | null)[]; perKeyMetrics: any }>}
	 */
	private async getMultipleByKeys(
		storeName: string,
		keys: string[]
	): Promise<{ results: (any | null)[]; perKeyMetrics: any }> {
		// flush & 스토어 메타데이터 얻기
		const { storeMeta, keyMap, metrics } = await this.flushAndGetMetadata(
			storeName
		);

		// 와일드카드 확장
		const expandedKeys = this.expandAllWildcards(keys, keyMap);

		// 확장된 키들을 기반으로 모든 행 읽기
		const { results, perKeyMetrics } = await this.readAllRows(
			storeName,
			storeMeta,
			keyMap,
			expandedKeys
		);

		return { results, perKeyMetrics };
	}

	/**
	 * 단일 SortDefinition에 대해, 하나의 객체(레코드)에 해당하는 필드 오프셋을 Uint32Array로 만든다.
	 *
	 * @param objectData - 필드를 추출할 원본 객체
	 * @param sortDefinition - `name`과 `sortFields`를 담은 정의
	 * @returns 단일 정의에 대한 필드 값을 32비트 정수로 인코딩한 배열
	 */
	private getJsonFieldOffsetsForSingleDefinition(
		objectData: any,
		sortDefinition: SortDefinition
	): Uint32Array {
		// 필드별 숫자 배열 생성
		const fieldArrays: Uint32Array[] = [];
		for (const field of sortDefinition.sortFields) {
			const rawValue = this.getValueByPath(objectData, field.path);
			const numericArray = this.convertValueToUint32Array(
				rawValue,
				field.dataType,
				field.sortDirection
			);
			fieldArrays.push(numericArray);
		}

		// 최종 하나의 Uint32Array로 합침
		let totalLength = 0;
		for (const arr of fieldArrays) {
			totalLength += arr.length;
		}
		const finalResult = new Uint32Array(totalLength);

		let offset = 0;
		for (const arr of fieldArrays) {
			finalResult.set(arr, offset);
			offset += arr.length;
		}

		return finalResult;
	}

	/**
	 * dot 표기("user.address.street" 등)의 경로를 따라 객체에서 값을 가져온다.
	 */
	private getValueByPath(obj: any, path: string): any {
		if (!path) return obj;
		const segments = path.split(".");
		let current = obj;
		for (const seg of segments) {
			if (current == null) return undefined;
			current = current[seg];
		}
		return current;
	}

	/**
	 * JS 값(날짜, 숫자, 문자열)을 Uint32Array로 변환한다.
	 * 오름차순/내림차순에 따라 비트를 반전할지 여부를 적용.
	 */
	private convertValueToUint32Array(
		value: any,
		dataType: "string" | "number" | "date",
		direction: "Asc" | "Desc"
	): Uint32Array {
		// Desc면 반전, Asc면 그대로
		const invert = direction === "Desc";

		switch (dataType) {
			case "date":
				return this.serializeDate(value, invert);
			case "number":
				return this.serializeNumber(value, invert);
			case "string":
				return this.serializeString(value, invert);
			default:
				// 알 수 없거나 null
				const fallback = new Uint32Array(1);
				fallback[0] = invert ? 0xffffffff : 0;
				return fallback;
		}
	}

	/**
	 * 예: Date(또는 날짜 문자열)을 64비트로 표현 → 32비트 2개 [hi, lo].
	 */
	private serializeDate(rawValue: any, invert: boolean): Uint32Array {
		// null/undefined 처리
		if (rawValue == null) {
			return new Uint32Array([
				invert ? 0xffffffff : 0,
				invert ? 0xffffffff : 0,
			]);
		}

		// rawValue → epoch ms 변환
		let ms: number;
		if (typeof rawValue === "number") {
			ms = rawValue;
		} else if (rawValue instanceof Date) {
			ms = rawValue.getTime();
		} else {
			const str = String(rawValue);
			const cached = this.dateParseCache.get(str);
			if (cached !== undefined) {
				ms = cached;
			} else {
				ms = Date.parse(str);
				this.dateParseCache.set(str, ms);
			}
		}

		// hi/lo
		const hi = Math.floor(ms / 0x100000000) >>> 0;
		const lo = ms >>> 0;

		// 반전 여부
		const out = new Uint32Array(2);
		if (!invert) {
			out[0] = hi;
			out[1] = lo;
		} else {
			out[0] = 0xffffffff - hi;
			out[1] = 0xffffffff - lo;
		}
		return out;
	}

	/**
	 * JS 숫자를 32비트 정수(0~2^32-1) 또는 64비트 부동소수점(2워드)로 직렬화.
	 */
	private serializeNumber(rawValue: any, invert: boolean): Uint32Array {
		// 유한수가 아니면 기본값
		if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
			const fallback = new Uint32Array(1);
			fallback[0] = invert ? 0xffffffff : 0;
			return fallback;
		}

		// [0, 2^32-1] 범위의 정수이면 32비트 하나로
		if (
			Number.isInteger(rawValue) &&
			rawValue >= 0 &&
			rawValue <= 0xffffffff
		) {
			const val32 = invert
				? (0xffffffff - rawValue) >>> 0
				: rawValue >>> 0;
			return new Uint32Array([val32]);
		}

		// 그 외엔 64비트 float(hi, lo) 2워드
		this.float64View.setFloat64(0, rawValue, true); // little-endian

		let lo = this.float64View.getUint32(0, true);
		let hi = this.float64View.getUint32(4, true);

		if (invert) {
			lo = 0xffffffff - lo;
			hi = 0xffffffff - hi;
		}

		return new Uint32Array([hi, lo]);
	}

	/**
	 * 문자열을 각 코드포인트를 32비트 정수로 저장(캐시 활용).
	 */
	private serializeString(rawValue: any, invert: boolean): Uint32Array {
		// 문자열이 아니면 빈 배열(혹은 반전 빈)을 반환
		if (typeof rawValue !== "string") {
			const fallback = new Uint32Array(1);
			fallback[0] = invert ? 0xffffffff : 0;
			return fallback;
		}

		// invert 구분을 포함한 캐시 키 생성
		const key = invert ? `1:${rawValue}` : `0:${rawValue}`;

		// 캐시 체크
		const cached = this.stringCache.get(key);
		if (cached) {
			return cached;
		}

		// 새로 코드포인트 계산
		const codePoints = new Uint32Array(rawValue.length);
		for (let i = 0; i < rawValue.length; i++) {
			const cp = rawValue.codePointAt(i)!;
			codePoints[i] = invert ? (0xffffffff - cp) >>> 0 : cp;
		}

		// 캐시에 저장
		this.stringCache.set(key, codePoints);

		return codePoints;
	}

	/**
	 * GPU 비토닉 정렬 방식을 통해 한 스토어/정의에 대한 rows를 정렬한다(간단한 예시).
	 * 2버퍼 기법(임시 + storage) 사용으로, STORAGE 버퍼를 직접 맵핑하지 않는다.
	 *
	 * @private
	 * @param {StoreMetadata} storeMeta - 정렬할 스토어 메타데이터
	 * @param {SortDefinition} sortDef - 정렬 정의
	 * @returns {Promise<void>} 정렬 완료 후 resolve (용량 초과 시 건너뜀)
	 */
	private async runGpuSortForDefinition(
		storeMeta: StoreMetadata,
		sortDef: SortDefinition
	): Promise<void> {
		const offsetsStoreName = `${storeMeta.storeName}-offsets`;
		const offsetsStoreMeta = this.storeMetadataMap.get(offsetsStoreName);
		if (!offsetsStoreMeta) {
			return;
		}

		const { sortItems, rowCount } = await this.buildSortItemsArray(
			storeMeta,
			offsetsStoreMeta,
			sortDef
		);
		if (rowCount < 2) {
			return;
		}
		console.log("sortItems: ", sortItems, "rowCount: ", rowCount);

		const totalBytes = sortItems.byteLength;

		// 디바이스 한도 체크
		const maxBinding =
			this.device.limits.maxStorageBufferBindingSize || 128 * 1024 * 1024;
		if (totalBytes > maxBinding) {
			console.error(
				`Sort data requires ${totalBytes} bytes, ` +
					`exceeding GPU limit of ${maxBinding}. Aborting.`
			);
			return;
		}

		// CPU → GPU 업로드용 스테이징 버퍼
		const stagingBuffer = this.device.createBuffer({
			size: totalBytes,
			usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
			mappedAtCreation: true,
		});

		new Uint32Array(stagingBuffer.getMappedRange()).set(sortItems);
		stagingBuffer.unmap();

		// STORAGE 용 버퍼
		const sortItemsBuffer = this.device.createBuffer({
			size: totalBytes,
			usage:
				GPUBufferUsage.STORAGE |
				GPUBufferUsage.COPY_DST |
				GPUBufferUsage.COPY_SRC,
		});

		// 스테이징 → STORAGE
		{
			const encoder = this.device.createCommandEncoder();
			encoder.copyBufferToBuffer(
				stagingBuffer,
				0,
				sortItemsBuffer,
				0,
				totalBytes
			);
			this.device.queue.submit([encoder.finish()]);
		}
		stagingBuffer.destroy();

		// 파이프라인 및 보조 버퍼들 생성
		const { pipeline } = this.createBitonicSortPipelineForJson();
		const paramBuffer = this.createParamBuffer();
		const debugAtomicBuffer = this.createDebugAtomicBuffer();
		const zeroBuffer = this.createZeroBuffer();

		// 비토닉 패턴
		const paddedCount = 1 << Math.ceil(Math.log2(rowCount));
		const itemFieldCount = this.computeFieldCountForDefinition(sortDef);

		// 바인드 그룹 생성
		const bindGroup = this.device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: sortItemsBuffer } },
				{ binding: 1, resource: { buffer: paramBuffer } },
				{ binding: 2, resource: { buffer: debugAtomicBuffer } },
			],
		});

		// 단계별 실행
		for (let size = 2; size <= paddedCount; size <<= 1) {
			for (let halfSize = size >> 1; halfSize > 0; halfSize >>= 1) {
				await this.runBitonicPassJson(
					pipeline,
					bindGroup,
					paramBuffer,
					debugAtomicBuffer,
					zeroBuffer,
					size,
					halfSize,
					rowCount,
					paddedCount,
					itemFieldCount
				);
			}
		}

		const finalRowIds = await this.readBackSortedRowIds(
			sortItemsBuffer,
			rowCount,
			itemFieldCount
		);

		// 정리
		sortItemsBuffer.destroy();
		paramBuffer.destroy();
		debugAtomicBuffer.destroy();
		zeroBuffer.destroy();
	}

	/**
	 * 해당 SortDefinition의 필드가 몇 개인지(각각 2 워드라 가정) 계산.
	 */
	private computeFieldCountForDefinition(sortDef: SortDefinition): number {
		// 각 필드는 32비트 2개씩 사용한다고 가정
		return sortDef.sortFields.length * 2;
	}

	/**
	 * GPU에서 정렬된 아이템을 다시 읽어 rowId 부분만 반환한다.
	 *
	 * @private
	 * @param {GPUBuffer} itemsBuffer - 최종 정렬된 버퍼
	 * @param {number} rowCount - 실제 아이템 개수(패딩 제외)
	 * @param {number} fieldsPerItem - 숫자 필드 개수
	 * @returns {Promise<Uint32Array>} 오름차순으로 정렬된 rowId 배열
	 */
	private async readBackSortedRowIds(
		itemsBuffer: GPUBuffer,
		rowCount: number,
		fieldsPerItem: number
	): Promise<Uint32Array> {
		if (rowCount === 0) return new Uint32Array();

		// 각 아이템은 (1 + fieldsPerItem)개의 u32
		const stride = 1 + fieldsPerItem;
		const totalWords = rowCount * stride;
		const totalBytes = totalWords * 4;

		// 스테이징 버퍼 생성
		const staging = this.device.createBuffer({
			size: totalBytes,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		});

		// itemsBuffer → staging 복사
		{
			const cmd = this.device.createCommandEncoder();
			console.log("copyBufferToBuffer4");
			cmd.copyBufferToBuffer(itemsBuffer, 0, staging, 0, totalBytes);
			this.device.queue.submit([cmd.finish()]);
			await this.device.queue.onSubmittedWorkDone();
		}

		// 스테이징 매핑
		await staging.mapAsync(GPUMapMode.READ);
		const copyArray = new Uint32Array(staging.getMappedRange().slice(0));
		staging.unmap();
		staging.destroy();

		// 각 아이템 첫 워드가 rowId
		const result = new Uint32Array(rowCount);
		for (let i = 0; i < rowCount; i++) {
			const base = i * stride;
			result[i] = copyArray[base];
		}
		return result;
	}

	private async runBitonicPassJson(
		pipeline: GPUComputePipeline,
		bindGroup: GPUBindGroup,
		paramBuffer: GPUBuffer,
		debugAtomicBuffer: GPUBuffer,
		zeroBuffer: GPUBuffer,
		size: number,
		halfSize: number,
		rowCount: number,
		paddedCount: number,
		fieldsPerItem: number
	) {
		// 1) debug atomic을 0으로 리셋
		await this.resetDebugAtomicBuffer(debugAtomicBuffer, zeroBuffer);

		// 2) param 버퍼 쓰기: [size, halfSize, rowCount, paddedCount, fieldsPerItem]
		const paramData = new Uint32Array([
			size,
			halfSize,
			rowCount,
			paddedCount,
			fieldsPerItem,
		]);
		this.device.queue.writeBuffer(paramBuffer, 0, paramData);

		// 3) 디스패치
		const commandEncoder = this.device.createCommandEncoder();
		const pass = commandEncoder.beginComputePass();
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, bindGroup);

		const workgroups = Math.ceil(paddedCount / 256);
		pass.dispatchWorkgroups(workgroups);
		pass.end();

		this.device.queue.submit([commandEncoder.finish()]);
		await this.device.queue.onSubmittedWorkDone();
	}

	/**
	 * 한 (store, definition) 쌍에 대한 offsets-store 데이터(숫자 필드들)를 모아,
	 * "sort items"라는 단일 TypedArray를 만든다.
	 *
	 * 각 행: [ rowId, field0, field1, ... fieldN ]
	 *
	 * @private
	 * @param {StoreMetadata} storeMeta - 메인 스토어 메타데이터
	 * @param {StoreMetadata} offsetsStoreMeta - 해당 메인 스토어의 offsets 스토어 메타데이터
	 * @param {SortDefinition} sortDef - offsets가 필요한 정렬 정의
	 * @returns {Promise<{ sortItems: Uint32Array; rowCount: number }>}
	 */
	private async buildSortItemsArray(
		storeMeta: StoreMetadata,
		offsetsStoreMeta: StoreMetadata,
		sortDef: SortDefinition
	): Promise<{ sortItems: Uint32Array; rowCount: number }> {
		const offsetsKeyMap = this.storeKeyMap.get(offsetsStoreMeta.storeName)!;
		const allKeys = Array.from(offsetsKeyMap.keys());
		const matchedKeys = allKeys.filter((k) =>
			k.endsWith(`::${sortDef.name}`)
		);

		if (matchedKeys.length === 0) {
			return { sortItems: new Uint32Array(0), rowCount: 0 };
		}

		// 관련 offsets 행 전부 가져오기
		const { results } = await this.getMultipleByKeys(
			offsetsStoreMeta.storeName,
			matchedKeys
		);
		const mainKeyMap = this.storeKeyMap.get(storeMeta.storeName)!;

		// 전체 워드 수 계산. 행당 (1 + offsetData.length)
		let totalWords = 0;
		for (const r of results) {
			if (r && r instanceof Uint32Array) {
				totalWords += 1 + r.length;
			}
		}

		// 하나의 배열로 묶기
		const rowCount = matchedKeys.length;
		const combined = new Uint32Array(totalWords);

		// 채우기
		let writePos = 0;
		for (let i = 0; i < matchedKeys.length; i++) {
			const offsetKey = matchedKeys[i];
			const offsetData = results[i] as Uint32Array | null;
			if (!offsetData) {
				continue;
			}
			const mainKey = offsetKey.replace(`::${sortDef.name}`, "");
			const rowId = mainKeyMap.get(mainKey) ?? 0;

			combined[writePos++] = rowId;
			combined.set(offsetData, writePos);
			writePos += offsetData.length;
		}

		return { sortItems: combined, rowCount };
	}

	private createBitonicSortPipelineForJson(): {
		pipeline: GPUComputePipeline;
	} {
		const code = /* wgsl */ `
struct Params {
  size: u32,
  halfSize: u32,
  rowCount: u32,
  paddedCount: u32,
  fieldsPerItem: u32
}

@group(0) @binding(0) var<storage, read_write> items: array<u32>; // [rowId, f0, f1, ...]
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var<storage, read_write> debugAtomic: atomic<u32>;

fn lexCompare(aStart: u32, bStart: u32, fields: u32) -> bool {
  // A가 B보다 큰 경우 true를 반환(오름차순 swap 체크용).
  for (var i = 0u; i < fields; i++) {
    let av = items[aStart + 1u + i];
    let bv = items[bStart + 1u + i];
    if (av < bv) { return false; }
    if (av > bv) { return true; }
  }
  return false;
}

fn compareAndSwap(i: u32, j: u32) {
  let stride = 1u + params.fieldsPerItem;
  let aStart = i * stride;
  let bStart = j * stride;

  let aShouldSwap = lexCompare(aStart, bStart, params.fieldsPerItem);
  if (aShouldSwap) {
    for (var w = 0u; w < stride; w++) {
      let tmp = items[aStart + w];
      items[aStart + w] = items[bStart + w];
      items[bStart + w] = tmp;
    }
    atomicStore(&debugAtomic, 1u);
  }
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= params.paddedCount) {
    return;
  }

  let size = params.size;
  let halfSize = params.halfSize;

  let flip = (i & (size >> 1u)) != 0u;
  let mate = i ^ halfSize;
  if (mate < params.paddedCount && mate != i) {
    if (i < mate) {
      compareAndSwap(i, mate);
    } else {
      compareAndSwap(mate, i);
    }
  }
}
`;

		const module = this.device.createShaderModule({ code });
		const pipeline = this.device.createComputePipeline({
			layout: "auto",
			compute: { module, entryPoint: "main" },
		});
		return { pipeline };
	}

	/**
	 * 비토닉 정렬 파라미터를 저장할 uniform 버퍼를 생성.
	 *
	 * @private
	 * @returns {GPUBuffer} u32 5개를 저장할 버퍼
	 */
	private createParamBuffer(): GPUBuffer {
		return this.device.createBuffer({
			size: 5 * 4,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
	}

	/**
	 * 원자적 디버그 버퍼(스왑 확인 등)에 사용될 버퍼를 생성한다.
	 *
	 * @private
	 * @returns {GPUBuffer} 원자적 연산이 가능한 버퍼
	 */
	private createDebugAtomicBuffer(): GPUBuffer {
		const buffer = this.device.createBuffer({
			size: 4,
			usage:
				GPUBufferUsage.STORAGE |
				GPUBufferUsage.COPY_SRC |
				GPUBufferUsage.COPY_DST,
			mappedAtCreation: true,
		});
		new Uint32Array(buffer.getMappedRange()).set([0]);
		buffer.unmap();
		return buffer;
	}

	/**
	 * 32비트 0 하나를 담고 있는 작은 GPU 버퍼를 만들어, 다른 버퍼를 리셋할 때 사용한다.
	 *
	 * @private
	 * @returns {GPUBuffer} 0 값만 있는 작은 버퍼
	 */
	private createZeroBuffer(): GPUBuffer {
		const zeroBuffer = this.device.createBuffer({
			size: 4,
			usage: GPUBufferUsage.COPY_SRC,
			mappedAtCreation: true,
		});
		new Uint32Array(zeroBuffer.getMappedRange()).set([0]);
		zeroBuffer.unmap();
		return zeroBuffer;
	}

	/**
	 * 디버그 원자 버퍼를 0으로 리셋한다(작은 zeroBuffer에서 복사).
	 *
	 * @private
	 * @param {GPUBuffer} debugAtomicBuffer - 원자값이 저장된 버퍼
	 * @param {GPUBuffer} zeroBuffer - 단일 0 값을 가진 버퍼
	 * @returns {Promise<void>} 리셋 완료 시 resolve
	 */
	private async resetDebugAtomicBuffer(
		debugAtomicBuffer: GPUBuffer,
		zeroBuffer: GPUBuffer
	): Promise<void> {
		const cmd = this.device.createCommandEncoder();
		cmd.copyBufferToBuffer(zeroBuffer, 0, debugAtomicBuffer, 0, 4);
		this.device.queue.submit([cmd.finish()]);
		await this.device.queue.onSubmittedWorkDone();
	}

	/**
	 * 메인 스토어 쓰기(행 메타데이터, 버퍼 등)를 처리한다.
	 * add/put 양쪽에서 재사용.
	 *
	 * @private
	 * @param {StoreMetadata} storeMeta - 쓰려는 스토어 메타데이터
	 * @param {string} key - 고유 키
	 * @param {any} value - 직렬화 후 쓸 데이터
	 * @param {"add"|"put"} operationType - add인지 put인지
	 * @returns {Promise<void>} 메타데이터 업데이트 및 쓰기 큐 등록이 끝나면 resolve
	 */
	private async writeRecordToStore(
		storeMeta: StoreMetadata,
		key: string,
		value: any,
		operationType: "add" | "put"
	): Promise<void> {
		const keyMap = this.storeKeyMap.get(storeMeta.storeName)!;
		const arrayBuffer = this.serializeValueForStore(storeMeta, value);

		// 행 메타데이터 찾기 또는 생성
		const rowMetadata = await this.findOrCreateRowMetadata(
			storeMeta,
			keyMap,
			key,
			arrayBuffer,
			operationType
		);

		// GPU 버퍼 가져오기
		const gpuBuffer = this.getBufferByIndex(
			storeMeta,
			rowMetadata.bufferIndex
		);

		// 메인 스토어 쓰기를 대기열에 추가
		this.pendingWrites.push({
			storeMeta,
			rowMetadata,
			arrayBuffer,
			gpuBuffer,
			operationType,
		});
	}

	/**
	 * 이 스토어가 가진 모든 정렬 정의에 대해 `<storeName>-offsets` 스토어에 오프셋 배열을 쓴다.
	 * 각 정의를 독립적으로 처리한다.
	 *
	 * @private
	 * @param {StoreMetadata} storeMeta - 메인 스토어의 메타데이터
	 * @param {string} key - 메인 스토어에서의 키
	 * @param {any} value - JSON 데이터
	 * @param {"add"|"put"} operationType - 작업 타입
	 * @returns {Promise<void>} 모든 오프셋 쓰기가 큐에 등록되면 resolve
	 */
	private async writeOffsetsForAllDefinitions(
		storeMeta: StoreMetadata,
		key: string,
		value: any,
		operationType: "add" | "put"
	): Promise<void> {
		const offsetsStoreName = `${storeMeta.storeName}-offsets`;
		const offsetsStoreMeta = this.storeMetadataMap.get(offsetsStoreName);
		if (!offsetsStoreMeta) {
			// offsets 스토어가 없으면 할 게 없음
			return;
		}

		const offsetsKeyMap = this.storeKeyMap.get(offsetsStoreName)!;

		// 각 정렬 정의를 독립적으로 처리
		for (const singleDefinition of storeMeta.sortDefinition!) {
			// 1) 해당 정의에 대한 숫자 키 계산
			const singleDefinitionOffsets =
				this.getJsonFieldOffsetsForSingleDefinition(
					value,
					singleDefinition
				);

			// 3) ArrayBuffer 복제
			const offsetsCopy = new Uint32Array(singleDefinitionOffsets);
			const offsetsArrayBuffer = offsetsCopy.buffer;

			// 4) 복합 키(예: `<key>::<definitionName>`)
			const offsetRowKey = `${key}::${singleDefinition.name}`;

			// 5) offsets 스토어에서 row 메타데이터 찾거나 생성
			const offsetsRowMetadata = await this.findOrCreateRowMetadata(
				offsetsStoreMeta,
				offsetsKeyMap,
				offsetRowKey,
				offsetsArrayBuffer,
				operationType
			);

			// 6) 오프셋 스토어의 GPU 버퍼 가져오기
			const offsetsGpuBuffer = this.getBufferByIndex(
				offsetsStoreMeta,
				offsetsRowMetadata.bufferIndex
			);

			// 7) 오프셋 쓰기 요청을 pendingWrites에 추가
			this.pendingWrites.push({
				storeMeta: offsetsStoreMeta,
				rowMetadata: offsetsRowMetadata,
				arrayBuffer: offsetsArrayBuffer,
				gpuBuffer: offsetsGpuBuffer,
				operationType,
			});
		}
	}

	/**
	 * 메인 스토어에 대한 offsets 스토어( `<storeName>-offsets` )의 GPU 버퍼 사용량(바이트)을 로깅한다.
	 *
	 * @param {string} storeName - **메인** 스토어 이름. 내부적으로 "<storeName>-offsets"를 찾는다.
	 */
	public async logOffsetsStoreUsage(storeName: string): Promise<any | null> {
		const offsetsStoreName = `${storeName}-offsets`;
		const offsetsStoreMeta = this.storeMetadataMap.get(offsetsStoreName);
		if (!offsetsStoreMeta) {
			console.warn(`No offsets store found for ${offsetsStoreName}.`);
			return;
		}

		let totalUsed = 0;
		for (const bufferMeta of offsetsStoreMeta.buffers) {
			const buffer = bufferMeta.gpuBuffer;
			if (!buffer) continue;
			// (gpuBuffer as any)._usedBytes에 사용된 바이트가 추적됨.
			const usedBytes = (buffer as any)._usedBytes || 0;
			totalUsed += usedBytes;
		}
	}
}
