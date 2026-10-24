/** Cancellation survives agent-loop replacement and asynchronous prompt preflight. */
export class RunCancellation {
	private generation = 0;
	stopped = false;

	capture(): number {
		return this.generation;
	}

	isCurrent(generation: number): boolean {
		return generation === this.generation;
	}

	resume(): void {
		this.stopped = false;
	}

	cancel(): void {
		this.generation++;
		this.stopped = true;
	}

	check(generation: number): void {
		if (!this.isCurrent(generation)) throw new Error("Operation cancelled");
	}

	async run(
		prompt: () => Promise<void>,
		postRun: () => Promise<boolean>,
		continuation: () => Promise<void>,
	): Promise<void> {
		const generation = this.capture();
		await prompt();
		while (this.isCurrent(generation) && (await postRun()) && this.isCurrent(generation)) {
			await continuation();
		}
	}
}
