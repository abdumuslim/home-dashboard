import { Bell, BellOff } from "lucide-react";
import { usePrayerTimes } from "@/hooks/use-prayer-times";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { PrayerCard } from "@/components/cards/prayer-card";

export function PrayerSection() {
  const { prayers, hijriDate, islamicEvent } = usePrayerTimes();
  const { isSupported, isSubscribed, permission, subscribe, unsubscribe } = usePushNotifications();

  const handleBellClick = () => {
    if (isSubscribed) {
      unsubscribe();
    } else {
      subscribe();
    }
  };

  return (
    <section className="mb-6">
      <div className="px-0.5 pt-5 pb-3 flex items-center justify-between">
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
        {isSupported && permission !== "denied" && (
          <button
            onClick={handleBellClick}
            className="p-1.5 rounded-lg transition-colors hover:bg-white/10"
            title={isSubscribed ? "Disable prayer notifications" : "Enable prayer notifications"}
          >
            {isSubscribed ? (
              <Bell className="w-4 h-4 text-yellow" />
            ) : (
              <BellOff className="w-4 h-4 text-dim" />
            )}
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {prayers.map((prayer) => (
          <PrayerCard key={prayer.name} prayer={prayer} />
        ))}
      </div>
    </section>
  );
}
