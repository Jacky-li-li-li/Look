import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { isLoggedInAtom, userProfileAtom } from "../../store/authAtoms";

/** 空状态的时段问候：每 60s 刷新；0–5 点归入"深夜"档。 */
export function TimeGreeting() {
	const { t } = useTranslation();
	const isLoggedIn = useAtomValue(isLoggedInAtom);
	const { userName } = useAtomValue(userProfileAtom);
	const [hour, setHour] = useState(() => new Date().getHours());

	useEffect(() => {
		const id = setInterval(() => setHour(new Date().getHours()), 60_000);
		return () => clearInterval(id);
	}, []);

	const hourKey =
		hour < 5
			? "chat.greetingNight"
			: hour < 12
				? "chat.greetingMorning"
				: hour < 18
					? "chat.greetingAfternoon"
					: "chat.greetingEvening";

	return (
		<h3 className="text-[13px] font-semibold text-foreground">
			{isLoggedIn && userName ? t(hourKey, { name: userName }) : t("chat.greetingNoName")}
		</h3>
	);
}
