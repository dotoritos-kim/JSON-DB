import {
	IDBOptions,
	RowMetadata,
	SortDefinition,
	StoreMetadata,
} from "../types/StoreMetadata";
import { compareKeys, likeToRegex, ROW_INACTIVE_FLAG } from "../utils";
import { VramDataBase } from "../VramDataBase";

export class StoreManager extends VramDataBase {
	constructor(device: GPUDevice) {
		super(device);
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
		this.FlushManager.resetFlushTimer();
		await this.FlushManager.checkAndFlush();
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
		this.FlushManager.resetFlushTimer();
		await this.FlushManager.checkAndFlush();
	}

	/**
	 * GPU 기반 스토어에서 특정 키의 데이터를 getMultiple 메서드를 통해 가져온다.
	 * 읽기 전에 모든 대기 중인 쓰기가 flush된다.
	 * @async
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
	 * @async
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
	public async getMultiple<T>(
		storeName: string,
		keys: string[]
	): Promise<(T | null)[]>;
	public async getMultiple<T>(
		storeName: string,
		skip: number,
		take: number
	): Promise<(T | null)[]>;
	public async getMultiple<T>(
		storeName: string,
		param2: string[] | number,
		param3?: number
	): Promise<(T | null)[]> {
		if (Array.isArray(param2)) {
			// 오버로드 1: 키 배열로 가져오기
			const keys = param2;
			const { results } = await this.getMultipleByKeys<T>(
				storeName,
				keys
			);
			return results;
		} else if (typeof param2 === "number" && typeof param3 === "number") {
			// 오버로드 2: 페이지네이션 (skip, take)
			const skip = param2;
			const take = param3;

			// flush & 스토어 메타데이터 가져오기
			const { keyMap } =
				await this.SerializationManager.flushAndGetMetadata<T>(
					storeName
				);

			// 스토어의 keyMap을 배열로 바꾼다
			const allKeys = Array.from(keyMap.keys());

			const { results } = await this.readRowsWithPagination<T>(
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
	 * @async
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
			gpuBuffer: this.GpuBufferAllocator.getBufferByIndex(
				storeMeta,
				rowMetadata.bufferIndex
			),
			operationType: "delete",
			key, // flush 시 메타데이터 업데이트에 필요
		});

		// flush 타이머 리셋
		this.FlushManager.resetFlushTimer();

		// 배치 크기 초과 확인
		await this.FlushManager.checkAndFlush();
	}

	/**
	 * 지정된 오브젝트 스토어의 모든 행을 제거하고, 모든 GPU 버퍼를 파괴한다.
	 * 그 후, 새 버퍼를 하나 만들어서 사용한다.
	 * @async
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
	 * @async
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
			activeKeys = this.SortManager.applyCustomRange(
				activeKeys,
				options.range
			);
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
	 * 지정된 스토어 이름에 대한 keyMap을 가져온다.
	 *
	 *
	 * @param {string} storeName - 스토어 이름
	 * @returns {Map<string, number>} 해당 스토어의 키 맵
	 * @throws {Error} 스토어가 없으면 새 맵을 반환(혹은 에러)
	 */
	getKeyMap(storeName: string): Map<string, number> {
		const keyMap = this.storeKeyMap.get(storeName);
		if (!keyMap) {
			return new Map<string, number>();
		}
		return keyMap;
	}

	/**
	 * 메인 스토어 쓰기(행 메타데이터, 버퍼 등)를 처리한다.
	 * add/put 양쪽에서 재사용.
	 * @async
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
		const arrayBuffer = this.SerializationManager.serializeValueForStore(
			storeMeta,
			value
		);

		// 행 메타데이터 찾기 또는 생성
		const rowMetadata =
			await this.SerializationManager.findOrCreateRowMetadata(
				storeMeta,
				keyMap,
				key,
				arrayBuffer,
				operationType
			);

		// GPU 버퍼 가져오기
		const gpuBuffer = this.GpuBufferAllocator.getBufferByIndex(
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
	 * @async
	 * @param {StoreMetadata} storeMeta - 메인 스토어의 메타데이터
	 * @param {string} key - 메인 스토어에서의 키
	 * @param {any} value - JSON 데이터
	 * @param {"add"|"put"} operationType - 작업 타입
	 * @returns {Promise<void>} 모든 오프셋 쓰기가 큐에 등록되면 resolve
	 */
	async writeOffsetsForAllDefinitions(
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
			const offsetsRowMetadata =
				await this.SerializationManager.findOrCreateRowMetadata(
					offsetsStoreMeta,
					offsetsKeyMap,
					offsetRowKey,
					offsetsArrayBuffer,
					operationType
				);

			// 6) 오프셋 스토어의 GPU 버퍼 가져오기
			const offsetsGpuBuffer = this.GpuBufferAllocator.getBufferByIndex(
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
				return this.SerializationManager.serializeDate(value, invert);
			case "number":
				return this.SerializationManager.serializeNumber(value, invert);
			case "string":
				return this.SerializationManager.serializeString(value, invert);
			default:
				// 알 수 없거나 null
				const fallback = new Uint32Array(1);
				fallback[0] = invert ? 0xffffffff : 0;
				return fallback;
		}
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
	 *
	 * @param {string[]} keys - (와일드카드 포함 가능) 키 배열
	 * @param {Map<string, any>} keyMap - 스토어 키 맵
	 * @returns {string[]} 확장된 키들의 합쳐진 배열
	 */
	expandAllWildcards(keys: string[], keyMap: Map<string, any>): string[] {
		return keys.flatMap((key) => this.expandWildcard(key, keyMap));
	}

	/**
	 * 주어진 키에 대한 활성화된 행 메타데이터를 찾는다(비활성 플래그가 아니어야 함).
	 *
	 *
	 * @param {Map<string, number>} keyMap - 키 → 행 ID 매핑
	 * @param {string} key - 찾을 키
	 * @param {RowMetadata[]} rows - 해당 스토어의 행 메타데이터 목록
	 * @returns {RowMetadata | null} 찾고 활성화된 메타데이터, 없으면 null
	 */
	findActiveRowMetadata(
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
}
