export function offsetDate(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function getEasterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

export function getHolidays(year) {
  const fixed = [
    { month: 0, day: 1, name: "Neujahr" },
    { month: 4, day: 1, name: "Tag der Arbeit" },
    { month: 9, day: 3, name: "Tag der Deutschen Einheit" },
    { month: 10, day: 1, name: "Allerheiligen" },
    { month: 11, day: 25, name: "1. Weihnachtstag" },
    { month: 11, day: 26, name: "2. Weihnachtstag" },
  ];

  const easter = getEasterSunday(year);
  const movable = [
    { date: offsetDate(easter, 0), name: "Ostersonntag" },
    { date: offsetDate(easter, -2), name: "Karfreitag" },
    { date: offsetDate(easter, 1), name: "Ostermontag" },
    { date: offsetDate(easter, 39), name: "Christi Himmelfahrt" },
    { date: offsetDate(easter, 49), name: "Pfingstsonntag" },
    { date: offsetDate(easter, 50), name: "Pfingstmontag" },
    { date: offsetDate(easter, 60), name: "Fronleichnam" },
  ];

  return fixed
    .map((date) => ({
      date: new Date(year, date.month, date.day),
      name: date.name,
    }))
    .concat(movable);
}

export function updateHolidayMaps(year, holidaySet, holidayNameMap) {
  holidaySet.clear();
  holidayNameMap.clear();
  [year - 1, year, year + 1].forEach((targetYear) => {
    getHolidays(targetYear).forEach((holiday) => {
      const key = `${holiday.date.getFullYear()}-${String(holiday.date.getMonth() + 1).padStart(2, "0")}-${String(holiday.date.getDate()).padStart(2, "0")}`;
      holidaySet.add(key);
      holidayNameMap.set(key, holiday.name);
    });
  });
}
