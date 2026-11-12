/** Authenticated, run-bound task protocol. No endpoint discovery or arbitrary host access. */
export class TaskClient {
	private readonly endpoint: string;
	private readonly token: string;
	private readonly fetchImpl: typeof fetch;

	constructor(endpoint: string, token: string, fetchImpl: typeof fetch = fetch) {
		if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(endpoint) || !token) {
			throw new Error("任务控制端点缺失或无效");
		}
		this.endpoint = endpoint;
		this.token = token;
		this.fetchImpl = fetchImpl;
	}

	async request(
		operation: "context" | "gate" | "ask" | "report" | "decide" | "read" | "route" | "note" | "reply",
		body: unknown,
		signal?: AbortSignal,
	): Promise<unknown> {
		const response = await this.fetchImpl(`${this.endpoint}/${operation}`, {
			method: "POST",
			headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
			redirect: "error",
		});
		const result: unknown = await response.json();
		if (!response.ok) {
			const error =
				result && typeof result === "object" && "error" in result ? String(result.error) : "任务控制服务拒绝请求";
			throw new Error(error);
		}
		return result;
	}
}
