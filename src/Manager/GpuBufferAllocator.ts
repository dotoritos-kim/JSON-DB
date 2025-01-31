import { BufferMetadata, StoreMetadata } from "../types/StoreMetadata";
import { roundUp } from "../utils";
import { VramDataBase } from "../VramDataBase";

export class GpuBufferAllocator {
	private parent: VramDataBase;

	constructor(device: GPUDevice, parent: VramDataBase) {
		this.parent = parent;
	}
	/**
	 * 새 GPU 버퍼를 생성하여 반환한다.
	 *
	 *
	 * @param {StoreMetadata} storeMeta - 새 GPU 버퍼를 필요한 스토어 메타데이터
	 * @param {number} size - 요청된 크기(대개 storeMeta.bufferSize에 해당)
	 * @returns {GPUBuffer} 새로 생성된 GPU 버퍼
	 */
	createNewBuffer(storeMeta: StoreMetadata, size: number): GPUBuffer {
		return this.parent.device.createBuffer({
			size: storeMeta.bufferSize,
			usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
			mappedAtCreation: false,
		});
	}
	/**
	 * 주어진 크기에 맞춰 이미 존재하는 GPU 버퍼에서 공간을 찾거나, 새로운 버퍼를 할당해 준다.
	 * GPU 버퍼 참조, 인덱스, 그리고 쓰기 오프셋을 반환한다.
	 *
	 *
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
		const gpuBuffer = this.parent.device.createBuffer({
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
		const newGpuBuffer = this.parent.device.createBuffer({
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

	createBitonicSortPipelineForJson(): {
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

		const module = this.parent.device.createShaderModule({ code });
		const pipeline = this.parent.device.createComputePipeline({
			layout: "auto",
			compute: { module, entryPoint: "main" },
		});
		return { pipeline };
	}
	/**
	 * 비토닉 정렬 파라미터를 저장할 uniform 버퍼를 생성.
	 *
	 *
	 * @returns {GPUBuffer} u32 5개를 저장할 버퍼
	 */
	createParamBuffer(): GPUBuffer {
		return this.parent.device.createBuffer({
			size: 5 * 4,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
	}

	/**
	 * 원자적 디버그 버퍼(스왑 확인 등)에 사용될 버퍼를 생성한다.
	 *
	 *
	 * @returns {GPUBuffer} 원자적 연산이 가능한 버퍼
	 */
	createDebugAtomicBuffer(): GPUBuffer {
		const buffer = this.parent.device.createBuffer({
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
	 *
	 * @returns {GPUBuffer} 0 값만 있는 작은 버퍼
	 */
	createZeroBuffer(): GPUBuffer {
		const zeroBuffer = this.parent.device.createBuffer({
			size: 4,
			usage: GPUBufferUsage.COPY_SRC,
			mappedAtCreation: true,
		});
		new Uint32Array(zeroBuffer.getMappedRange()).set([0]);
		zeroBuffer.unmap();
		return zeroBuffer;
	}

	/**
	 * 버퍼 인덱스에 해당하는 GPUBuffer 인스턴스를 가져온다.
	 *
	 *
	 * @param {StoreMetadata} storeMeta - 스토어 메타데이터
	 * @param {number} bufferIndex - 가져올 버퍼 인덱스
	 * @returns {GPUBuffer} 해당 인덱스의 GPU 버퍼
	 */
	getBufferByIndex(storeMeta: StoreMetadata, bufferIndex: number): GPUBuffer {
		const bufMeta = storeMeta.buffers[bufferIndex];
		if (!bufMeta || !bufMeta.gpuBuffer) {
			throw new Error(
				`Buffer index ${bufferIndex} not found or uninitialized.`
			);
		}
		return bufMeta.gpuBuffer;
	}

	/**
	 * 디버그 원자 버퍼를 0으로 리셋한다(작은 zeroBuffer에서 복사).
	 *
	 * @async
	 * @param {GPUBuffer} debugAtomicBuffer - 원자값이 저장된 버퍼
	 * @param {GPUBuffer} zeroBuffer - 단일 0 값을 가진 버퍼
	 * @returns {Promise<void>} 리셋 완료 시 resolve
	 */
	async resetDebugAtomicBuffer(
		debugAtomicBuffer: GPUBuffer,
		zeroBuffer: GPUBuffer
	): Promise<void> {
		const cmd = this.parent.device.createCommandEncoder();
		cmd.copyBufferToBuffer(zeroBuffer, 0, debugAtomicBuffer, 0, 4);
		this.parent.device.queue.submit([cmd.finish()]);
		await this.parent.device.queue.onSubmittedWorkDone();
	}
}
