import type { UserMessage } from "../types";

function userText(message: UserMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export default function UserBubble({ message }: { message: UserMessage }) {
  return (
    <div className="flex justify-end py-1">
      <div className="max-w-[75%] whitespace-pre-wrap rounded-2xl bg-[var(--bubble)] px-3.5 py-2 text-sm leading-relaxed">
        {userText(message)}
      </div>
    </div>
  );
}
