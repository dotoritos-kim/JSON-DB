import {
	InitialMetrics,
	PerKeyMetrics,
	RowInfo,
	RowMetadata,
	StoreMetadata,
} from "../types/StoreMetadata";
import { padJsonTo4Bytes, padTo4Bytes, ROW_INACTIVE_FLAG } from "../utils";
import { VramDataBase } from "../VramDataBase";

export class SerializationManager {
	private parent: VramDataBase;

	constructor(device: GPUDevice, parent: VramDataBase) {
		this.parent = parent;
	}
	/**
	 * 값(JSON, TypedArray, ArrayBuffer 등)을 GPU 버퍼에 기록하기 적합한 ArrayBuffer로 직렬화한다.
	 *
	 *
	 * @param {StoreMetadata} storeMeta - 쓰려는 스토어 메타데이터
	 * @param {any} value - 원본 값
	 * @returns {ArrayBuffer} GPU에 기록하기 위한 직렬화된 버퍼
	 */
	serializeValueForStore(storeMeta: StoreMetadata, value: any): ArrayBuffer {
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
	 * 예: Date(또는 날짜 문자열)을 64비트로 표현 → 32비트 2개 [hi, lo].
	 */
	serializeDate(rawValue: any, invert: boolean): Uint32Array {
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
			const cached = this.parent.dateParseCache.get(str);
			if (cached !== undefined) {
				ms = cached;
			} else {
				ms = Date.parse(str);
				this.parent.dateParseCache.set(str, ms);
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
	serializeNumber(rawValue: any, invert: boolean): Uint32Array {
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
		this.parent.float64View.setFloat64(0, rawValue, true); // little-endian

		let lo = this.parent.float64View.getUint32(0, true);
		let hi = this.parent.float64View.getUint32(4, true);

		if (invert) {
			lo = 0xffffffff - lo;
			hi = 0xffffffff - hi;
		}

		return new Uint32Array([hi, lo]);
	}

	/**
	 * 문자열을 각 코드포인트를 32비트 정수로 저장(캐시 활용).
	 */
	serializeString(rawValue: any, invert: boolean): Uint32Array {
		// 문자열이 아니면 빈 배열(혹은 반전 빈)을 반환
		if (typeof rawValue !== "string") {
			const fallback = new Uint32Array(1);
			fallback[0] = invert ? 0xffffffff : 0;
			return fallback;
		}

		// invert 구분을 포함한 캐시 키 생성
		const key = invert ? `1:${rawValue}` : `0:${rawValue}`;

		// 캐시 체크
		const cached = this.parent.stringCache.get(key);
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
		this.parent.stringCache.set(key, codePoints);

		return codePoints;
	}

	/**
	 * 주어진 키에 대한 기존 행 메타데이터를 찾고, 없으면 새로 만든다.
	 *
	 * @async
	 * @param {StoreMetadata} storeMeta - 스토어 메타데이터
	 * @param {Map<string, number>} keyMap - 키 → 행 인덱스 매핑
	 * @param {string} key - 고유 키
	 * @param {ArrayBuffer} arrayBuffer - 이 행에 할당할 데이터
	 * @param {"add"|"put"} operationType - 어떤 작업인지(add인지 put인지)
	 * @returns {Promise<RowMetadata>} 행 메타데이터
	 */
	async findOrCreateRowMetadata(
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
		const { gpuBuffer, bufferIndex, offset } =
			this.parent.GpuBufferAllocator.findOrCreateSpace(
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
	 * @async
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
			const { gpuBuffer, bufferIndex, offset } =
				this.parent.GpuBufferAllocator.findOrCreateSpace(
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
	 * 대기 중인 모든 쓰기를 flush한 뒤, 해당 스토어 메타데이터와 keyMap을 반환한다.
	 *
	 * @async
	 * @param {string} storeName - 스토어 이름
	 * @returns {Promise<{ storeMeta: StoreMetadata; keyMap: Map<string, number>; metrics: InitialMetrics }>}
	 *    flush 후 스토어의 메타데이터와 keyMap, 그리고 간단한 측정값
	 */
	async flushAndGetMetadata<T>(storeName: string): Promise<{
		storeMeta: StoreMetadata;
		keyMap: Map<string, T>;
		metrics: InitialMetrics;
	}> {
		const performanceMetrics: InitialMetrics = {
			flushWrites: 0,
			metadataRetrieval: 0,
		};

		const flushStart = performance.now();
		await this.parent.FlushManager.flushWrites();
		performanceMetrics.flushWrites = performance.now() - flushStart;

		const metadataStart = performance.now();
		const storeMeta = this.parent.getStoreMetadata(
			storeName
		) as StoreMetadata;
		const keyMap = this.parent.StoreManager.getKeyMap(storeName) as Map<
			string,
			T
		>;
		performanceMetrics.metadataRetrieval =
			performance.now() - metadataStart;

		return { storeMeta, keyMap, metrics: performanceMetrics };
	}

	/**
	 * `bigCopiedData`로부터 각 행을 서브어레이로 잘라, 원래 타입(JSON/TypedArray/ArrayBuffer)으로 역직렬화하고
	 * 결과 배열(results)에 저장한다.
	 *
	 *
	 * @param {RowInfo[]} rowInfos - 행 메타데이터(오프셋, 길이 등)
	 * @param {StoreMetadata} storeMeta - 스토어 메타데이터
	 * @param {Uint8Array} bigCopiedData - 합쳐진 모든 바이트
	 * @param {(any | null)[]} results - 결과를 저장할 배열
	 * @param {PerKeyMetrics} perKeyMetrics - 측정값
	 * @returns {void}
	 */
	deserializeRows(
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
}
