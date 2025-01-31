import { FlushManager } from "./Manager/FlushManager";
import { GpuBufferAllocator } from "./Manager/GpuBufferAllocator";
import { SerializationManager } from "./Manager/SerializationManager";
import { SortManager } from "./Manager/SortManager";
import { StoreManager } from "./Manager/StoreManager";
import {
	IDBOptions,
	PendingWrite,
	PerKeyMetrics,
	RowInfo,
	StoreMetadata,
} from "./types/StoreMetadata";

export interface IDataBaseManager {
	FlushManager: FlushManager;
	GpuBufferAllocator: GpuBufferAllocator;
	SerializationManager: SerializationManager;
	SortManager: SortManager;
	StoreManager: StoreManager;
}
export class VramDataBase {
	public storeMetadataMap: Map<string, StoreMetadata>;
	public storeKeyMap: Map<string, Map<string, number>>;
	public pendingWrites: PendingWrite[] = [];
	protected readonly BATCH_SIZE = 10000;
	protected flushTimer: number | null = null;
	public isReady: boolean | null = true;
	protected waitUntilReadyPromise: Promise<void> | null = null;
	protected readyResolver: (() => void) | null = null;
	protected float64Buffer = new ArrayBuffer(8);
	protected float64View = new DataView(this.float64Buffer);
	protected dateParseCache = new Map<string, number>();
	protected stringCache = new Map<string, Uint32Array>();

	public FlushManager: FlushManager;
	public GpuBufferAllocator: GpuBufferAllocator;
	public SerializationManager: SerializationManager;
	public SortManager: SortManager;
	public StoreManager: StoreManager;
	/**
	 * VramDataBase 클래스를 초기화한다.
	 * @param {GPUDevice} device - 버퍼 작업에 사용할 GPU 디바이스
	 */
	constructor(public device: GPUDevice) {
		this.storeMetadataMap = new Map();
		this.storeKeyMap = new Map();
		this.StoreManager = new StoreManager(this.device);
		this.SortManager = new SortManager(this.device);
		this.SerializationManager = new SerializationManager(this.device);
		this.FlushManager = new FlushManager(this.device);
		this.GpuBufferAllocator = new GpuBufferAllocator(this.device);
	}

	/**
	 * 키 배열에 대해 행 데이터를 읽는다(두 단계):
	 *  1) 스토어의 GPU 버퍼 여러 개에서 단일 "big read buffer"(bigReadBuffer)로 복사
	 *  2) bigReadBuffer에서 CPU로 매핑된 스테이징 버퍼로 복사 후, 그 데이터를 사용
	 * @async
	 * @private
	 * @param {string} storeName - 읽을 스토어 이름
	 * @param {StoreMetadata} storeMeta - 스토어 메타데이터
	 * @param {Map<string, any>} keyMap - 키 맵
	 * @param {string[]} keys - 읽을 키들
	 * @returns {Promise<{ results: (any | null)[]; perKeyMetrics: PerKeyMetrics }>}
	 *   - `results`: 역직렬화된 값들(키가 없으면 null)
	 *   - `perKeyMetrics`: 작업 단계별 시간 정보
	 */
	protected async readAllRows<T>(
		storeName: string,
		storeMeta: StoreMetadata,
		keyMap: Map<string, any>,
		keys: string[]
	): Promise<{ results: (T | null)[]; perKeyMetrics: PerKeyMetrics }> {
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
		this.SerializationManager.deserializeRows(
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
	private collectRowInfos<T>(
		keyMap: Map<string, any>,
		storeMeta: StoreMetadata,
		keys: string[],
		results: (T | null)[],
		perKeyMetrics: PerKeyMetrics
	): { rowInfos: RowInfo[]; totalBytes: number } {
		const findMetadataStart = performance.now();

		const rowInfos: RowInfo[] = [];
		let totalBytes = 0;

		for (let i = 0; i < keys.length; i++) {
			const key = keys[i];
			const rowMetadata = this.StoreManager.findActiveRowMetadata(
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
			const srcBuffer = this.GpuBufferAllocator.getBufferByIndex(
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
	 * @async
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
	 * 메인 스토어에 대한 offsets 스토어( `<storeName>-offsets` )의 GPU 버퍼 사용량(바이트)을 로깅한다.
	 * @async
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
	/**
	 * 스토어 이름으로 메타데이터 객체를 가져온다.
	 *
	 * @private
	 * @param {string} storeName - 스토어 이름
	 * @returns {StoreMetadata} 해당 스토어의 메타데이터
	 * @throws {Error} 스토어가 없으면 에러
	 */
	protected getStoreMetadata(storeName: string): StoreMetadata {
		const meta = this.storeMetadataMap.get(storeName);
		if (!meta) {
			throw new Error(`Object store "${storeName}" does not exist.`);
		}
		return meta;
	}
	/**
	 * getMultiple 메서드의 오버로드 버전 중, 키 배열을 인자로 받았을 때 내부적으로 호출되는 메서드.
	 * @async
	 * @private
	 * @param {string} storeName - 스토어 이름
	 * @param {string[]} keys - 가져올 키 배열
	 * @returns {Promise<{ results: (T | null)[]; perKeyMetrics: any }>}
	 */
	protected async getMultipleByKeys<T>(
		storeName: string,
		keys: string[]
	): Promise<{ results: (T | null)[]; perKeyMetrics: any }> {
		// flush & 스토어 메타데이터 얻기
		const { storeMeta, keyMap, metrics } =
			await this.SerializationManager.flushAndGetMetadata(storeName);

		// 와일드카드 확장
		const expandedKeys = this.StoreManager.expandAllWildcards(keys, keyMap);

		// 확장된 키들을 기반으로 모든 행 읽기
		const { results, perKeyMetrics } = await this.readAllRows<T>(
			storeName,
			storeMeta,
			keyMap,
			expandedKeys
		);

		return { results, perKeyMetrics };
	}

	/**
	 * 각 타이밍 값을 0으로 초기화한 PerKeyMetrics 객체를 생성하여 반환한다.
	 *
	 * @private
	 * @returns {PerKeyMetrics} 초기화된 메트릭 객체
	 */
	protected initializeMetrics(): PerKeyMetrics {
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
	 * @protected
	 * @returns {Promise<void>} VramDataBase가 ready 상태가 되면 resolve
	 */
	protected waitUntilReady(): Promise<void> {
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
	 * @async
	 * @protected
	 * @param {string} storeName - 스토어 이름
	 * @param {string[]} allKeys - 스토어의 모든 키
	 * @param {number} skip - 스킵할 레코드 수
	 * @param {number} take - 스킵 후 가져올 레코드 수
	 * @returns {Promise<{ results: (any | null)[]; perKeyMetrics: any }>}
	 *    `results` 배열을 포함하는 객체를 resolve
	 */
	protected async readRowsWithPagination<T>(
		storeName: string,
		allKeys: any,
		skip: number,
		take: number
	): Promise<{ results: (T | null)[]; perKeyMetrics: any }> {
		// 키 배열 슬라이스
		const paginatedKeys = allKeys.slice(skip, skip + take);

		// getMultipleByKeys로 페치
		const { results, perKeyMetrics } = await this.getMultipleByKeys<T>(
			storeName,
			paginatedKeys
		);

		return { results, perKeyMetrics };
	}
}
