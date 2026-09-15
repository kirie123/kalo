import { memo } from "react";
import type { TimelineEntry } from "../lib/timeline";
import AssistantMessage from "./AssistantMessage";
import ChangedFilesCard from "./ChangedFilesCard";
import CompactionBubble from "./CompactionBubble";
import RetryNotice from "./RetryNotice";
import ToolCallGroup, { ToolCallList } from "./ToolCallGroup";
import UserBubble from "./UserBubble";

/**
 * Renders one timeline entry. Used both at top level (MessageList) and inside a
 * work segment (WorkSegment).
 *
 * `inSegment` drops the tool-group shell: the segment header already carries
 * the per-tool counts, so keeping the group header would stack two summaries
 * over one row. Everything else renders identically in both places.
 *
 * Memoized: the store's throttled flush clones only mutated entries, so
 * untouched timeline items skip re-rendering entirely during streaming.
 */
const TimelineItem = memo(function TimelineItem({
  entry,
  copyText,
  inSegment = false,
}: {
  entry: TimelineEntry;
  copyText?: string;
  inSegment?: boolean;
}) {
  switch (entry.kind) {
    case "user":
      return <UserBubble message={entry.message} />;
    case "assistant":
      return (
        <AssistantMessage
          message={entry.message}
          streaming={entry.streaming}
          usage={entry.usage}
          copyText={copyText}
          errorRetried={entry.retriedError}
        />
      );
    case "toolGroup":
      return inSegment ? (
        <ToolCallList calls={entry.calls} />
      ) : (
        <ToolCallGroup toolName={entry.toolName} calls={entry.calls} />
      );
    case "retry":
      return (
        <RetryNotice
          attempt={entry.attempt}
          maxAttempts={entry.maxAttempts}
          delayMs={entry.delayMs}
          errorMessage={entry.errorMessage}
          done={entry.done}
        />
      );
    case "notice":
      return <div className="text-center text-xs text-dim">{entry.text}</div>;
    case "compaction":
      return <CompactionBubble entry={entry} />;
    case "changes":
      return (
        <ChangedFilesCard files={entry.files} totalAdded={entry.totalAdded} totalRemoved={entry.totalRemoved} />
      );
  }
});

export default TimelineItem;
