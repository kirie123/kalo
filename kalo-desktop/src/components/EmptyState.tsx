import InputBox from "./InputBox";

export default function EmptyState() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4">
      <h1 className="mb-8 text-3xl font-semibold tracking-tight">我们该做什么？</h1>
      <div className="w-full max-w-3xl">
        <InputBox />
      </div>
    </div>
  );
}
