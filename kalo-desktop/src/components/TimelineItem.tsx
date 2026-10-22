import { memo } from "react";
import type { TimelineEntry } from "../lib/timeline";
import ArtifactsCard from "./ArtifactsCard";
import AssistantMessage from "./AssistantMessage";
import ChangedFilesCard from "./ChangedFilesCard";
import CompactionBubble from "./CompactionBubble";
import RetryNotice from "./RetryNotice";
import ToolCallGroup from "./ToolCallGroup";
import UserBubble from "./UserBubble";
import WidgetCard from "./WidgetCard";

/**
 * Renders one timeline entry. Used both at top level (MessageList) and inside a
 * work segment (WorkSegment).
 *
 * `inSegment` uses quiet activity rows within the expanded whole-run process.
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
          compact={inSegment}
        />
      );
    case "toolGroup":
      return <ToolCallGroup toolName={entry.toolName} calls={entry.calls} compact={inSegment} />;
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
        <ChangedFilesCard
          files={entry.files}
          totalAdded={entry.totalAdded}
          totalRemoved={entry.totalRemoved}
          artifacts={entry.artifacts}
        />
      );
    case "artifacts":
      return <ArtifactsCard summary={entry.summary} />;
    case "widget":
      return <WidgetCard summary={entry.summary} />;
  }
});

export default TimelineItem;
