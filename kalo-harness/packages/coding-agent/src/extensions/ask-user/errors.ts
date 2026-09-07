/**
 * Stable error taxonomy for `askUser`.
 *
 * The four codes mean different things to the model, so they must not collapse
 * into one generic failure: `ASK_ABORTED` means "this turn is over",
 * `ASK_CANCELLED` means "the user will not answer but the conversation
 * continues" — a model that cannot tell them apart re-asks the moment the user
 * dismisses the card.
 */

export type AskUserErrorCode =
	/** No surface can collect structured answers (headless run, no provider). */
	| "NO_ASK_CHANNEL"
	/** The user dismissed the request to speak instead. */
	| "ASK_CANCELLED"
	/** The owning turn was aborted (stop button, engine teardown). */
	| "ASK_ABORTED"
	/** The surface returned an answer batch that does not fit the questions. */
	| "BAD_ANSWER";

/** An askUser failure carrying a machine-routable code. */
export class AskUserError extends Error {
	readonly code: AskUserErrorCode;

	constructor(code: AskUserErrorCode, message: string) {
		super(message);
		this.name = "AskUserError";
		this.code = code;
	}
}
