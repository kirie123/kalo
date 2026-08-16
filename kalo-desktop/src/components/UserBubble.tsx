import type { UserMessage } from "../types";
import CopyButton from "./CopyButton";

function userText(message: UserMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export default function UserBubble({ message }: { message: UserMessage }) {
  const text = userText(message);
  return (
    <div className="group flex flex-col items-end py-1">
      <div className="max-w-[75%] whitespace-pre-wrap rounded-2xl bg-[var(--bubble)] px-3.5 py-2 text-sm leading-relaxed">
        {text}
      </div>
      <div className="pt-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <CopyButton text={text} title="复制这条输入" />
      </div>
    </div>
  );
}
