"use client";

import React, { useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceArea,
} from "recharts";
import type { TooltipProps } from "recharts";
import { Activity, Clock, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { BackendHealthHistory, BackendHealthPoint } from "@/lib/api";

type HealthStatus = "healthy" | "unhealthy" | "unknown";

// ─── helpers ────────────────────────────────────────────────────────────────

function toMinuteKey(iso: string): string {
  return iso.slice(0, 16);
}

function formatLabel(cursor: Date, spanMs: number): string {
  if (spanMs <= 48 * 3_600_000) {
    // ≤ 48 h → time only (covers 1 h / 6 h / 12 h / 24 h / 2 d presets)
    // Matches Overview's minute-granularity axis format exactly
    return cursor.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  if (spanMs <= 7 * 86_400_000) {
    // 2 d – 7 d with hourly buckets → need the date visible too
    return cursor.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  // > 7 d → date only, same as Overview day-granularity axis
  return cursor.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface Slot {
  time: string;
  timeLabel: string;
  status: HealthStatus | "gap";
  /** null breaks the line (gap / outage) */
  latency: number | null;
  /** always 1 (online) or null (offline/gap) — used when no latency data available */
  online: number | null;
  latency_ms: number | null;
  message: string | null;
}

function buildSlots(
  from: Date,
  to: Date,
  points: BackendHealthPoint[],
  bucketMinutes: number,
): Slot[] {
  // Build minute-key lookup
  const lookup = new Map<string, BackendHealthPoint>();
  for (const p of points) {
    lookup.set(toMinuteKey(p.time), p);
  }

  const slots: Slot[] = [];
  const cursor = new Date(from);
  const spanMs = to.getTime() - from.getTime();

  while (cursor <= to) {
    const bucketStart = cursor.toISOString().slice(0, 16);

    // Collect all raw points that fall within this bucket
    const bucketPoints: BackendHealthPoint[] = [];
    const tmp = new Date(cursor);
    for (let m = 0; m < bucketMinutes; m++) {
      const key = tmp.toISOString().slice(0, 16);
      const pt = lookup.get(key);
      if (pt) bucketPoints.push(pt);
      tmp.setMinutes(tmp.getMinutes() + 1);
    }

    const timeLabel = formatLabel(new Date(cursor), spanMs);

    if (bucketPoints.length === 0) {
      slots.push({
        time: bucketStart,
        timeLabel,
        status: "gap",
        latency: null,
        online: null,
        latency_ms: null,
        message: null,
      });
    } else {
      // Worst-case status for the bucket
      const hasUnhealthy = bucketPoints.some((p) => p.status === "unhealthy");
      const hasUnknown   = bucketPoints.some((p) => p.status === "unknown");
      const status: HealthStatus = hasUnhealthy ? "unhealthy" : hasUnknown ? "unknown" : "healthy";

      // Average latency
      const lats = bucketPoints
        .filter((p) => p.latency_ms !== null)
        .map((p) => p.latency_ms as number);
      const avgLatency = lats.length > 0
        ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length)
        : null;

      // Last message
      const lastMsg = bucketPoints[bucketPoints.length - 1].message ?? null;

      slots.push({
        time: bucketStart,
        timeLabel,
        status,
        // Latency-line: only draw when healthy; null during outage breaks the area
        latency: status === "healthy" ? avgLatency : null,
        // Binary online-line: 1 when healthy, null otherwise (for agent-mode backends)
        online:  status === "healthy" ? 1 : null,
        latency_ms: avgLatency,
        message: lastMsg,
      });
    }

    cursor.setMinutes(cursor.getMinutes() + bucketMinutes);
  }

  return slots;
}

/**
 * Only gaps that sit *between* the first and last recorded data point are
 * treated as downtime ("unhealthy").  Leading / trailing gaps — time slots
 * before monitoring started or beyond the last check — stay as "gap" so they
 * render as blank space, not as a fault region.
 *
 * The original `slots` array (used for stats / gap counting) is never mutated.
 */
function resolveGapSlots(slots: Slot[]): Slot[] {
  const firstData = slots.findIndex((s) => s.status !== "gap");
  if (firstData === -1) return slots; // no data at all

  let lastData = -1;
  for (let i = slots.length - 1; i >= 0; i--) {
    if (slots[i].status !== "gap") { lastData = i; break; }
  }

  return slots.map((s, i) => {
    if (s.status !== "gap") return s;
    // Interior gap → treat as downtime
    if (i > firstData && i < lastData) return { ...s, status: "unhealthy" as const };
    // Leading / trailing gap → leave blank
    return s;
  });
}

/** Find contiguous spans of a non-healthy state for ReferenceArea shading.
 *  x1/x2 use `slot.time` (unique UTC ISO minute string) so that duplicate
 *  timeLabels in a 24-hour view (where the first and last label are identical)
 *  don't cause recharts to misposition the shaded regions.
 */
function buildRefSpans(
  slots: Slot[],
): Array<{ x1: string; x2: string; type: "unhealthy" | "unknown" | "gap" }> {
  const spans: ReturnType<typeof buildRefSpans> = [];
  let spanStart: string | null = null;
  let spanType: "unhealthy" | "unknown" | "gap" | null = null;

  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const isProblematic = s.status !== "healthy";

    if (isProblematic && spanStart === null) {
      spanStart = s.time;
      spanType = s.status as "unhealthy" | "unknown" | "gap";
    } else if (!isProblematic && spanStart !== null) {
      spans.push({ x1: spanStart, x2: slots[i - 1].time, type: spanType! });
      spanStart = null;
      spanType = null;
    } else if (isProblematic && spanType !== null && s.status !== spanType) {
      // status type changed within a problematic run — split span
      spans.push({ x1: spanStart!, x2: slots[i - 1].time, type: spanType });
      spanStart = s.time;
      spanType = s.status as "unhealthy" | "unknown" | "gap";
    }
  }
  if (spanStart !== null) {
    spans.push({ x1: spanStart, x2: slots[slots.length - 1].time, type: spanType! });
  }
  return spans;
}

// ─── component ──────────────────────────────────────────────────────────────

interface BackendHealthChartProps {
  history: BackendHealthHistory;
  from: Date;
  to: Date;
  bucketMinutes?: number;
}

export const BackendHealthChart = React.memo(function BackendHealthChart({
  history,
  from,
  to,
  bucketMinutes = 1,
}: BackendHealthChartProps) {
  const t = useTranslations("health");
  const spanMs = to.getTime() - from.getTime();

  const slots = useMemo(
    () => buildSlots(from, to, history.points, bucketMinutes),
    [from, to, history.points, bucketMinutes],
  );

  const refSpans = useMemo(() => buildRefSpans(resolveGapSlots(slots)), [slots]);

  // Map from unique `time` key → display label, used as XAxis tickFormatter so
  // the axis shows readable labels while x1/x2 reference unique time strings.
  const labelMap = useMemo(
    () => new Map(slots.map((s) => [s.time, s.timeLabel])),
    [slots],
  );

  const stats = useMemo(() => {
    const checked = slots.filter((s) => s.status !== "gap");
    const healthy = checked.filter((s) => s.status === "healthy").length;
    const uptimePct = checked.length > 0 ? (healthy / checked.length) * 100 : null;
    const lats = checked
      .filter((s) => s.latency_ms !== null)
      .map((s) => s.latency_ms as number);
    const avgLatency = lats.length > 0
      ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length)
      : null;
    const maxLatency = lats.length > 0 ? Math.max(...lats) : null;
    const gaps = slots.filter((s) => s.status === "gap").length;
    return { uptimePct, avgLatency, maxLatency, gaps };
  }, [slots]);

  // Does this backend emit latency data? (direct mode)
  const hasLatency = useMemo(
    () => history.points.some((p) => p.latency_ms !== null),
    [history.points],
  );

  // The Y-axis dataKey we'll plot
  const dataKey = hasLatency ? "latency" : "online";

  const currentStatus =
    history.points.length > 0
      ? history.points[history.points.length - 1].status
      : "unknown";

  const statusDotClass =
    currentStatus === "healthy"
      ? "bg-emerald-500"
      : currentStatus === "unhealthy"
        ? "bg-rose-500"
        : "bg-slate-400";

  // ── Tooltip ────────────────────────────────────────────────────────────────
  const CustomTooltip = React.useCallback(
    ({ active, payload }: TooltipProps<number, string>) => {
      if (!active || !payload?.length) return null;
      const slot = payload[0].payload as Slot;

      // Parse the stored ISO minute string as UTC → local, then format like Overview
      const slotDate = new Date(
        slot.time.endsWith("Z") ? slot.time : slot.time + "Z",
      );
      const tooltipTitle =
        spanMs > 7 * 86_400_000
          ? slotDate.toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })
          : slotDate.toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            });

      const statusLabel =
        slot.status === "healthy"
          ? t("statusHealthy")
          : slot.status === "unhealthy"
            ? t("statusUnhealthy")
            : slot.status === "unknown"
              ? t("statusUnknown")
              : t("noData");

      const statusClass =
        slot.status === "healthy"
          ? "text-emerald-500"
          : slot.status === "unhealthy"
            ? "text-rose-500"
            : "text-slate-400";

      return (
        <div className="bg-popover border border-border rounded-lg p-3 shadow-lg text-xs space-y-1 min-w-[130px]">
          <p className="text-muted-foreground font-medium">{tooltipTitle}</p>
          <p className={cn("font-semibold", statusClass)}>{statusLabel}</p>
          {slot.latency_ms !== null && (
            <p className="text-muted-foreground flex items-center gap-1">
              <Clock className="w-3 h-3" />
              <span className="tabular-nums font-medium">{slot.latency_ms}ms</span>
            </p>
          )}
          {slot.message && slot.status !== "healthy" && (
            <p className="text-muted-foreground max-w-[200px] truncate opacity-80">
              {slot.message}
            </p>
          )}
        </div>
      );
    },
    [t, spanMs],
  );

  // ── Skeleton ───────────────────────────────────────────────────────────────
  if (slots.length === 0) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className={cn("inline-flex w-2 h-2 rounded-full shrink-0", statusDotClass)} />
          <span className="font-medium text-sm truncate">{history.backendName}</span>
        </div>
        <div className="h-[180px] w-full bg-muted/20 rounded-xl animate-pulse flex items-center justify-center">
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-2">
      {/* Title row */}
      <div className="flex items-center gap-2">
        <Activity className="w-4 h-4 text-muted-foreground shrink-0" />
        <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider truncate">
          {history.backendName}
        </p>
        <span className={cn("inline-flex w-2 h-2 rounded-full shrink-0", statusDotClass)} />
      </div>

      {/* Stats row — desktop inline / mobile cards */}
      {/* Mobile */}
      <div className="grid grid-cols-3 gap-2 lg:hidden">
        {stats.uptimePct !== null && (
          <div className="flex flex-col items-center py-1.5 px-1 rounded-md bg-secondary/50 border border-border/50">
            <span className="text-[9px] text-muted-foreground">{t("uptime")}</span>
            <span className={cn("text-xs font-bold tabular-nums",
              stats.uptimePct >= 99 ? "text-emerald-500" : stats.uptimePct >= 90 ? "text-amber-500" : "text-rose-500")}>
              {stats.uptimePct.toFixed(1)}%
            </span>
          </div>
        )}
        {stats.avgLatency !== null && (
          <div className="flex flex-col items-center py-1.5 px-1 rounded-md bg-secondary/50 border border-border/50">
            <span className="text-[9px] text-muted-foreground">{t("avgLatency")}</span>
            <span className="text-xs font-semibold tabular-nums">{stats.avgLatency}ms</span>
          </div>
        )}
        {stats.maxLatency !== null && (
          <div className="flex flex-col items-center py-1.5 px-1 rounded-md bg-secondary/50 border border-border/50">
            <span className="text-[9px] text-muted-foreground">{t("maxLatency")}</span>
            <span className="text-xs font-semibold tabular-nums">{stats.maxLatency}ms</span>
          </div>
        )}
      </div>
      {/* Desktop */}
      <div className="hidden lg:flex items-center gap-6 text-xs">
        {stats.uptimePct !== null && (
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">{t("uptime")}:</span>
            <span className={cn("font-semibold tabular-nums",
              stats.uptimePct >= 99 ? "text-emerald-500" : stats.uptimePct >= 90 ? "text-amber-500" : "text-rose-500")}>
              {stats.uptimePct.toFixed(1)}%
            </span>
          </div>
        )}
        {stats.avgLatency !== null && (
          <div className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">{t("avgLatency")}:</span>
            <span className="font-semibold text-emerald-500 tabular-nums">{stats.avgLatency}ms</span>
          </div>
        )}
        {stats.maxLatency !== null && (
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">{t("maxLatency")}:</span>
            <span className="font-semibold tabular-nums">{stats.maxLatency}ms</span>
          </div>
        )}
        {stats.gaps > 0 && (
          <div className="flex items-center gap-1.5 ml-auto">
            <span className="text-slate-400 tabular-nums">
              {stats.gaps} {t("gaps")}
            </span>
          </div>
        )}
      </div>

      {/* Chart */}
      <div className="relative h-[180px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={slots} margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`colorHealth-${history.backendId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#10b981" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
              </linearGradient>
            </defs>

            <CartesianGrid
              strokeDasharray="3 3"
              vertical={false}
              stroke="#888888"
              strokeOpacity={0.2}
            />

            {/* Shade problematic spans — skip leading/trailing gaps (blank) */}
            {refSpans.filter((s) => s.type !== "gap").map((span, i) => (
              <ReferenceArea
                key={i}
                x1={span.x1}
                x2={span.x2}
                fill={
                  span.type === "unhealthy"
                    ? "rgba(244,63,94,0.22)"   // rose
                    : "rgba(251,191,36,0.18)"  // amber / unknown
                }
                stroke={
                  span.type === "unhealthy"
                    ? "rgba(244,63,94,0.5)"
                    : "rgba(251,191,36,0.4)"
                }
                strokeOpacity={1}
              />
            ))}

            <XAxis
              dataKey="time"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10, fill: "#888888" }}
              interval="preserveStartEnd"
              minTickGap={40}
              tickFormatter={(v) => labelMap.get(v) ?? v}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10, fill: "#888888" }}
              tickFormatter={hasLatency ? (v) => `${v}ms` : () => ""}
              width={hasLatency ? 44 : 0}
              domain={hasLatency ? ["auto", "auto"] : [0, 1.2]}
            />
            <Tooltip content={<CustomTooltip />} />

            <Area
              type="monotone"
              dataKey={dataKey}
              stroke="#10b981"
              strokeWidth={2}
              fillOpacity={1}
              fill={`url(#colorHealth-${history.backendId})`}
              connectNulls={false}
              isAnimationActive={false}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
},
  (prev, next) =>
    prev.history === next.history &&
    prev.from.getTime() === next.from.getTime() &&
    prev.to.getTime()   === next.to.getTime() &&
    prev.bucketMinutes  === next.bucketMinutes,
);
