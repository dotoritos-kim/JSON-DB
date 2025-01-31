import { SortDefinition, StoreMetadata } from "../types/StoreMetadata";
import { VramDataBase } from "../VramDataBase";

export class SortManager extends VramDataBase {
	constructor(device: GPUDevice) {
		super(device);
	}
	/**
	 * 사용자 정의 문자열 키 범위(lower/upper, inclusivity 등)를 적용해 배열의 키를 필터링한다.
	 *
	 *
	 * @param {string[]} keys - 필터링할 키들
	 * @param {{
	 *   lowerBound?: string;
	 *   upperBound?: string;
	 *   lowerInclusive?: boolean;
	 *   upperInclusive?: boolean;
	 * }} range - 범위와 포함 여부 설정
	 * @returns {string[]} 범위 조건을 충족하는 키들의 배열
	 */
	applyCustomRange(
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
	 * 모든 스토어 중 `sortsDirty = true` 인 곳의 정렬을 재구성한다.
	 * 각 스토어에 대해, `sortDefinition`을 순회하며 정렬을 재빌드한다.
	 *
	 * 이제 JSON에 대해서는 각 행별 숫자 데이터를 offsets 스토어에 저장하므로,
	 * GPU 버퍼를 사용해 정렬을 수행할 수 있도록 이 숫자 데이터를 모아서 정렬을 진행한다.
	 *
	 * @async
	 * @returns {Promise<void>} 모든 정렬 재빌드가 끝나면 resolve
	 */
	async rebuildAllDirtySorts(gpuSort?: boolean): Promise<void> {
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
	 * GPU 비토닉 정렬 방식을 통해 한 스토어/정의에 대한 rows를 정렬한다(간단한 예시).
	 * 2버퍼 기법(임시 + storage) 사용으로, STORAGE 버퍼를 직접 맵핑하지 않는다.
	 *
	 * @async
	 * @param {StoreMetadata} storeMeta - 정렬할 스토어 메타데이터
	 * @param {SortDefinition} sortDef - 정렬 정의
	 * @returns {Promise<void>} 정렬 완료 후 resolve (용량 초과 시 건너뜀)
	 */
	async runGpuSortForDefinition(
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
		const { pipeline } =
			this.GpuBufferAllocator.createBitonicSortPipelineForJson();
		const paramBuffer = this.GpuBufferAllocator.createParamBuffer();
		const debugAtomicBuffer =
			this.GpuBufferAllocator.createDebugAtomicBuffer();
		const zeroBuffer = this.GpuBufferAllocator.createZeroBuffer();

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
	 * 비토닉 정렬 파라미터를 저장할 uniform 버퍼를 생성.
	 *
	 *
	 * @returns {GPUBuffer} u32 5개를 저장할 버퍼
	 */
	createParamBuffer(): GPUBuffer {
		return this.device.createBuffer({
			size: 5 * 4,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
	}
	/**
	 * 해당 SortDefinition의 필드가 몇 개인지(각각 2 워드라 가정) 계산.
	 */
	computeFieldCountForDefinition(sortDef: SortDefinition): number {
		// 각 필드는 32비트 2개씩 사용한다고 가정
		return sortDef.sortFields.length * 2;
	}

	/**
	 * 한 (store, definition) 쌍에 대한 offsets-store 데이터(숫자 필드들)를 모아,
	 * "sort items"라는 단일 TypedArray를 만든다.
	 *
	 * 각 행: [ rowId, field0, field1, ... fieldN ]
	 * @async
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
	/**
	 * GPU에서 정렬된 아이템을 다시 읽어 rowId 부분만 반환한다.
	 * @async
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
		await this.GpuBufferAllocator.resetDebugAtomicBuffer(
			debugAtomicBuffer,
			zeroBuffer
		);

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
}
