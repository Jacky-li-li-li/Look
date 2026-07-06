// ============================================================
// UsageHeatmap — GitHub-style yearly contribution graph
// ============================================================

import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { usageDataAtom, type UsageAtomData } from "../../store/atoms";
import UsageStackedChart from "./UsageStackedChart";
const WEEK_DAYS = 7;
const WEEKS_IN_YEAR = 53;
const CELL_SIZE = 14;
const GAP = 3;

const LEVEL_CLASSES = [
  "bg-muted",
  "bg-emerald-200",
  "bg-emerald-300",
  "bg-emerald-500",
  "bg-emerald-700",
];

function formatLocalDateKey(value: Date | number | string): string {
  const date =
    typeof value === "number" || typeof value === "string"
      ? new Date(value)
      : value;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getLevel(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 6) return 3;
  return 4;
}

function startOfYear(year: number): Date {
  return new Date(year, 0, 1);
}

function getYearGrid(year: number): Date[] {
  const jan1 = startOfYear(year);
  const startDay = jan1.getDay(); // 0 = Sunday
  const start = new Date(year, 0, 1 - startDay);
  const days: Date[] = [];
  for (let i = 0; i < WEEK_DAYS * WEEKS_IN_YEAR; i++) {
    days.push(
      new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
    );
  }
  return days;
}

function monthLabelsForDays(
  days: Date[],
  locale: string,
  selectedYear: number,
): { colIndex: number; label: string }[] {
  const labels: { colIndex: number; label: string }[] = [];
  let lastMonth = -1;
  for (let col = 0; col < WEEKS_IN_YEAR; col++) {
    const day = days[col * WEEK_DAYS];
    // Only label weeks that belong to the selected year.
    if (day.getFullYear() !== selectedYear) continue;
    if (day.getMonth() !== lastMonth) {
      lastMonth = day.getMonth();
      labels.push({
        colIndex: col,
        label: day.toLocaleString(locale, { month: "short" }),
      });
    }
  }
  return labels;
}

function nonOverlappingLabels(
  labels: { colIndex: number; label: string }[],
): { colIndex: number; label: string }[] {
  const result: { colIndex: number; label: string }[] = [];
  let lastCol = -3;
  for (const item of labels) {
    if (item.colIndex - lastCol > 2) {
      result.push(item);
      lastCol = item.colIndex;
    }
  }
  return result;
}
export default function UsageHeatmap() {
  const { t, i18n } = useTranslation();
  const data = useAtomValue(usageDataAtom);
  const setUsageData = useSetAtom(usageDataAtom);
  const [selectedYear, setSelectedYear] = useState<number>(
    new Date().getFullYear(),
  );

  // 当 data 变更时同步年份选择
  useEffect(() => {
    const yearsArr = data?.years ?? [new Date().getFullYear()];
    setSelectedYear((prev) =>
      yearsArr.includes(prev)
        ? prev
        : (yearsArr[0] ?? new Date().getFullYear()),
    );
  }, [data]);
  // 首次挂载时触发 usage:get 拉取数据并写入 atom
  useEffect(() => {
    window.look
      .getUsage()
      .then((result: unknown) => {
        const r = result as
          | { success: boolean; usage?: UsageAtomData; error?: string }
          | null
          | undefined;
        if (r?.success && r.usage) {
          setUsageData(r.usage);
        }
      })
      .catch((err: unknown) => {
        console.error("Failed to load usage data:", err);
      });
  }, [setUsageData]);
  const days = useMemo(() => getYearGrid(selectedYear), [selectedYear]);
  const monthLabels = useMemo(
    () => monthLabelsForDays(days, i18n.language, selectedYear),
    [days, i18n.language, selectedYear],
  );
  const visibleMonthLabels = useMemo(
    () => nonOverlappingLabels(monthLabels),
    [monthLabels],
  );

  const total = useMemo(() => {
    if (!data) return 0;
    return days.reduce((sum, day) => {
      // 只统计选中年份内的日期，排除网格中相邻年份的填充日期（#C7）
      if (day.getFullYear() !== selectedYear) return sum;
      const key = formatLocalDateKey(day);
      return sum + (data.usage[key] ?? 0);
    }, 0);
  }, [data, days, selectedYear]);

  if (!data) {
    return (
      <div className="text-muted-foreground py-4 text-[11px]">
        {t("common.loading")}
      </div>
    );
  }

  const years = data?.years ?? [new Date().getFullYear()];
  const labelHeight = 16;
  const gridHeight = WEEK_DAYS * CELL_SIZE + (WEEK_DAYS - 1) * GAP;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-medium">
          {t("profile.contributions", { count: total, year: selectedYear })}
        </h3>
        <select
          value={selectedYear}
          onChange={(e) => setSelectedYear(Number(e.target.value))}
          className="h-7 rounded-md border border-border bg-transparent px-2 text-[11px] outline-none focus:border-foreground"
        >
          {years.map((year) => (
            <option key={year} value={year}>
              {year}
            </option>
          ))}
        </select>
      </div>

      <div className="flex min-w-0 gap-2">
        {/* Day labels */}
        <div
          className="flex shrink-0 flex-col justify-between text-[10px] text-muted-foreground"
          style={{ height: gridHeight, marginTop: labelHeight }}
        >
          <span className="flex items-center" style={{ height: CELL_SIZE }}>
            {t("profile.mon")}
          </span>
          <span className="flex items-center" style={{ height: CELL_SIZE }}>
            {t("profile.wed")}
          </span>
          <span className="flex items-center" style={{ height: CELL_SIZE }}>
            {t("profile.fri")}
          </span>
        </div>

        <div className="flex-1 min-w-0 overflow-x-auto">
          {/* Month labels */}
          <div className="relative" style={{ height: labelHeight }}>
            {visibleMonthLabels.map(({ colIndex, label }) => (
              <span
                key={colIndex}
                className="absolute top-0 text-[10px] text-muted-foreground"
                style={{ left: colIndex * (CELL_SIZE + GAP) }}
              >
                {label}
              </span>
            ))}
          </div>

          {/* Grid */}
          <div
            className="grid grid-rows-7 grid-flow-col"
            style={{
              gridTemplateRows: `repeat(${WEEK_DAYS}, ${CELL_SIZE}px)`,
              gridTemplateColumns: `repeat(${WEEKS_IN_YEAR}, ${CELL_SIZE}px)`,
              gap: GAP,
            }}
          >
            {days.map((day) => {
              const key = formatLocalDateKey(day);
              const count = data?.usage[key] ?? 0;
              const level = getLevel(count);
              const inYear = day.getFullYear() === selectedYear;
              return (
                <div
                  key={key + day.getTime()}
                  className={`rounded-sm ${inYear ? LEVEL_CLASSES[level] : "bg-transparent"}`}
                  style={{ width: CELL_SIZE, height: CELL_SIZE }}
                  title={
                    inYear
                      ? `${key}: ${count} ${t("profile.turns", { count })}`
                      : ""
                  }
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center justify-end gap-2 text-[10px] text-muted-foreground">
        <span>{t("profile.less")}</span>
        <div className="flex gap-1">
          {LEVEL_CLASSES.map((cls, index) => (
            <div
              key={index}
              className={`rounded-sm ${cls}`}
              style={{ width: CELL_SIZE, height: CELL_SIZE }}
            />
          ))}
        </div>
        <span>{t("profile.more")}</span>
      </div>

      <UsageStackedChart
        modelCost={data?.modelCost ?? {}}
        selectedYear={selectedYear}
      />
    </div>
  );
}
