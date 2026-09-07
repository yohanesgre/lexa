export function DashboardSkeleton() {
  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="skeleton" style={{ width: 160, height: 24 }} />
          <div className="skeleton mt-2" style={{ width: 96, height: 12 }} />
        </div>
        <div className="flex items-center gap-3">
          <div className="skeleton" style={{ width: 32, height: 32 }} />
          <div className="skeleton" style={{ width: 120, height: 32 }} />
        </div>
      </div>
      <div className="stats-bar" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        {[1, 2, 3].map((i) => (
          <div key={i} className="stat-card">
            <div className="skeleton" style={{ width: 72, height: 12 }} />
            <div className="skeleton mt-2" style={{ width: 48, height: 22 }} />
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-col gap-2">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="skeleton" style={{ height: 40 }} />
        ))}
      </div>
    </>
  );
}
