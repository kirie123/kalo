/** Abortable FIFO slots; transferring a slot keeps it counted until its next owner releases. */
export class Semaphore {
	private active = 0;
	private readonly limit: number;
	private readonly waiters: Array<{ grant: () => void }> = [];

	constructor(limit: number) {
		if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid concurrency limit");
		this.limit = limit;
	}

	acquire(signal?: AbortSignal): Promise<() => void> {
		signal?.throwIfAborted();
		return new Promise((resolve, reject) => {
			const waiter = {
				grant: () => {
					signal?.removeEventListener("abort", abort);
					let released = false;
					resolve(() => {
						if (released) return;
						released = true;
						const next = this.waiters.shift();
						if (next) next.grant();
						else this.active--;
					});
				},
			};
			const abort = () => {
				const index = this.waiters.indexOf(waiter);
				if (index < 0) return;
				this.waiters.splice(index, 1);
				signal?.removeEventListener("abort", abort);
				reject(signal?.reason ?? new Error("子 agent 已取消"));
			};
			if (this.active < this.limit) {
				this.active++;
				waiter.grant();
			} else {
				this.waiters.push(waiter);
				signal?.addEventListener("abort", abort, { once: true });
			}
		});
	}
}

const configured = Number(process.env.KALO_SUBAGENT_CONCURRENCY?.trim() || 6);
export const childSlots = new Semaphore(Number.isSafeInteger(configured) && configured >= 1 ? configured : 6);

/** Take the per-child lock before a global slot; queued resumes cannot double-drive a session. */
const childLocks = new Map<string, { semaphore: Semaphore; users: number }>();
export async function acquireChild(key: string, signal?: AbortSignal): Promise<() => void> {
	let entry = childLocks.get(key);
	if (!entry) {
		entry = { semaphore: new Semaphore(1), users: 0 };
		childLocks.set(key, entry);
	}
	const current = entry;
	current.users++;
	const cleanup = () => {
		if (--current.users === 0) childLocks.delete(key);
	};
	try {
		const release = await current.semaphore.acquire(signal);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			release();
			cleanup();
		};
	} catch (error) {
		cleanup();
		throw error;
	}
}
