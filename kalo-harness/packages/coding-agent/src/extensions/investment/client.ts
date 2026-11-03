import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export interface InvestmentJob {
	id: string;
	status: "running" | "completed" | "failed" | "cancelled";
	phase: string;
	error: string | null;
	result: unknown;
}

export class InvestmentClient {
	private readonly port: number;
	private readonly token: string;
	constructor(port: number, token: string) {
		this.port = port;
		this.token = token;
	}

	request<T>(command: object, id: string = randomUUID()): Promise<T> {
		return new Promise((resolve, reject) => {
			const socket = createConnection({ host: "127.0.0.1", port: this.port });
			const chunks: Buffer[] = [];
			let size = 0;
			let settled = false;
			const finish = (error?: Error, result?: T) => {
				if (settled) return;
				settled = true;
				socket.destroy();
				if (error) reject(error);
				else resolve(result as T);
			};
			socket.setTimeout(10_000, () =>
				finish(new Error(`投行连接超时，请求 ID：${id}；请查看面板任务状态，勿重复启动。`)),
			);
			socket.on("error", (error) => finish(new Error(`投行连接失败（${id}）：${error.message}`)));
			socket.on("end", () => finish(new Error(`投行连接提前关闭，请求 ID：${id}`)));
			socket.on("connect", () => {
				const body = JSON.stringify({ version: 1, id, token: this.token, command });
				if (Buffer.byteLength(body) + 1 > 65_536) return finish(new Error("投行请求超过 64 KiB"));
				socket.write(`${body}\n`);
			});
			socket.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > 16_000_000) return finish(new Error("投行结果过大"));
				chunks.push(chunk);
				if (!chunk.includes(10)) return;
				try {
					const response: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8").split("\n")[0]);
					if (
						!response ||
						typeof response !== "object" ||
						!("version" in response) ||
						response.version !== 1 ||
						!("ok" in response)
					)
						throw new Error("投行响应格式无效");
					if (response.ok !== true) throw new Error("error" in response ? String(response.error) : "投行操作失败");
					if (!("id" in response) || response.id !== id || !("result" in response))
						throw new Error("投行响应 ID 不匹配");
					finish(undefined, response.result as T);
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
				}
			});
		});
	}

	async wait(
		jobId: string,
		seconds: number,
		signal?: AbortSignal,
		onProgress?: (job: InvestmentJob) => void,
	): Promise<InvestmentJob> {
		const deadline = Date.now() + Math.min(600, Math.max(0, seconds)) * 1000;
		try {
			while (true) {
				signal?.throwIfAborted();
				const job = await this.request<InvestmentJob>({ operation: "status", jobId });
				signal?.throwIfAborted();
				if (job.status !== "running" || Date.now() >= deadline) return job;
				onProgress?.(job);
				await delay(700, undefined, { signal });
			}
		} catch (error) {
			if (signal?.aborted) {
				await this.request({ operation: "cancel", jobId });
				throw new Error(`已请求停止投行任务 ${jobId}，最终状态请查看面板。`);
			}
			throw error;
		}
	}

	async run(
		request: object,
		requestId: string,
		seconds: number,
		signal?: AbortSignal,
		onProgress?: (job: InvestmentJob) => void,
	): Promise<InvestmentJob> {
		signal?.throwIfAborted();
		// Do not abandon the start reply: an abort racing creation must still cancel the known job.
		const { jobId } = await this.request<{ jobId: string }>({ operation: "start", request }, requestId);
		return this.wait(jobId, seconds, signal, onProgress);
	}
}
