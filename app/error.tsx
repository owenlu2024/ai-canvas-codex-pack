"use client";

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="grid min-h-screen place-items-center bg-canvas p-8 text-primary">
      <div className="max-w-md rounded-[14px] border border-line bg-white p-6 shadow-soft">
        <h1 className="text-xl font-semibold">页面加载出错</h1>
        <p className="mt-3 text-sm leading-6 text-secondary">开发服务暂时没有加载完整，请重试一次。</p>
        <button className="mt-5 rounded-[10px] bg-primary px-4 py-2 text-sm font-semibold text-white" onClick={reset} type="button">
          重新加载
        </button>
      </div>
    </main>
  );
}
