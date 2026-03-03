import { usePrayerTimes } from "@/hooks/use-prayer-times";
import { PrayerCard } from "@/components/cards/prayer-card";

export function PrayerSectionHeader() {
  const { hijriDate, islamicEvent } = usePrayerTimes();

  return (
    <h2 className="text-base font-medium tracking-wider text-white">
      PRAYER TIMES{" "}
      <span className="text-dim text-[0.85rem] tracking-normal ml-2">
        {hijriDate}
        {islamicEvent && (
          <>
            <span className="mx-1.5">·</span>
            <span className={islamicEvent.isToday ? "text-yellow" : ""}>
              {islamicEvent.name}
            </span>
            {" "}
            <span className={islamicEvent.isToday ? "text-yellow" : ""}>
              {islamicEvent.isToday ? "Today" : `in ${islamicEvent.daysLeft} days`}
            </span>
          </>
        )}
      </span>
    </h2>
  );
}

export function PrayerSectionContent() {
  const { prayers } = usePrayerTimes();

  return (
    <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
      {prayers.map((prayer) => (
        <PrayerCard key={prayer.name} prayer={prayer} />
      ))}
    </div>
  );
}
