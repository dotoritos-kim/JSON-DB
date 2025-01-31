import { PendingWrite } from "../types/StoreMetadata";
import { VramDataBase } from "../VramDataBase";

export class FlushManager {
	private parent: VramDataBase;

	constructor(device: GPUDevice, parent: VramDataBase) {
		this.parent = parent;
	}
	/**
	 * 대기 중인 쓰기가 임계치에 도달했거나, 다른 조건으로 인해 flush가 필요하면 flush를 수행한다.
	 *
	 *
	 * @returns {Promise<void>} 만약 flush가 트리거되면 완료될 때 resolve
	 */
	async checkAndFlush(): Promise<void> {
		if (this.parent.pendingWrites.length >= this.parent.BATCH_SIZE) {
			if (this.parent.flushTimer !== null) {
				clearTimeout(this.parent.flushTimer);
				this.parent.flushTimer = null;
			}
			// 여기서 flush 완료를 대기
			await this.flushWrites();
		}
	}

	/**
	 * 대기 중인 모든 쓰기를 버퍼별로 모아 한 번에 GPU 버퍼에 기록한다.
	 * 이후 GPU 완료를 대기한다.
	 *
	 * @async
	 * @returns {Promise<void>} 모든 쓰기가 제출되고 큐가 완료되면 resolve
	 */
	async flushWrites(): Promise<void> {
		if (this.parent.pendingWrites.length === 0) {
			return;
		}

		// pendingWrites를 GPUBuffer 기준으로 그룹화한다
		const writesByBuffer: Map<GPUBuffer, PendingWrite[]> = new Map();
		for (const item of this.parent.pendingWrites) {
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
					this.parent.device.queue.writeBuffer(
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
		await this.parent.device.queue.onSubmittedWorkDone();

		// 성공적으로 기록된 항목은 pendingWrites에서 제거
		this.parent.pendingWrites = this.parent.pendingWrites.filter(
			(write) => !successfulWrites.has(write)
		);
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
	 * @async
	 * @returns {void}
	 */
	public resetFlushTimer(): void {
		if (this.parent.flushTimer !== null) {
			clearTimeout(this.parent.flushTimer);
		}
		this.parent.flushTimer = window.setTimeout(async () => {
			try {
				await this.flushWrites();
				await this.parent.SortManager.rebuildAllDirtySorts();
				this.parent.dateParseCache = new Map<string, number>();
				this.parent.stringCache = new Map<string, Uint32Array>();
			} catch (error) {
				console.error("Error during timed flush operation:", error);
			} finally {
				this.parent.flushTimer = null;

				if (this.parent.readyResolver) {
					this.parent.readyResolver();
					this.parent.readyResolver = null;
					this.parent.waitUntilReadyPromise = null;
				}

				this.parent.isReady = true;
			}
		}, 250);
	}
}
