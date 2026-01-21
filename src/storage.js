import { storageKey } from "./constants.js";

export function loadData(currentYear) {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey)) || {
      members: [],
      years: {},
    };
    return normalizeData(stored, currentYear);
  } catch (error) {
    return { members: [], years: {} };
  }
}

export function saveData(data) {
  localStorage.setItem(storageKey, JSON.stringify(data));
}

export function snapshotData(data) {
  return JSON.stringify(data);
}

export function applySnapshot(snapshot, data) {
  const parsed = JSON.parse(snapshot);
  data.members = parsed.members || [];
  data.years = parsed.years || {};
}

export function normalizeData(stored, currentYear) {
  const normalized = {
    members: Array.isArray(stored.members) ? stored.members : [],
    years: stored.years || {},
  };

  if (!normalized.members.length && stored.months) {
    const firstMonthWithMembers = Object.values(stored.months).find(
      (month) => month && Array.isArray(month.members) && month.members.length
    );
    if (firstMonthWithMembers) {
      normalized.members = firstMonthWithMembers.members.map((member) => ({
        name: member.name || "",
      }));
    }
  }

  if (stored.months && !normalized.years[currentYear]) {
    normalized.years[currentYear] = { months: stored.months };
  }

  Object.values(normalized.years).forEach((yearData) => {
    if (!yearData.months) {
      yearData.months = {};
    }
    if (!yearData.vacationDays) {
      yearData.vacationDays = {};
    }
    Object.values(yearData.months).forEach((month) => {
      if (month && month.members) {
        delete month.members;
      }
      if (month && !month.days) {
        month.days = {};
      }
      if (month && !month.approved) {
        month.approved = {};
      }
      if (month && month.days) {
        migrateHalfDayStatuses(month.days);
      }
    });
  });

  sortMembersAndReindex(normalized);
  return normalized;
}

export function sortMembersAndReindex(targetData) {
  const membersWithIndex = targetData.members.map((member, index) => ({
    ...member,
    originalIndex: index,
  }));
  const collator = new Intl.Collator("de", { sensitivity: "base" });
  membersWithIndex.sort((a, b) => {
    const nameA = (a.name || "").trim();
    const nameB = (b.name || "").trim();
    if (!nameA && !nameB) {
      return a.originalIndex - b.originalIndex;
    }
    if (!nameA) {
      return 1;
    }
    if (!nameB) {
      return -1;
    }
    const result = collator.compare(nameA, nameB);
    return result !== 0 ? result : a.originalIndex - b.originalIndex;
  });

  const indexMap = new Map();
  membersWithIndex.forEach((member, newIndex) => {
    indexMap.set(member.originalIndex, newIndex);
  });

  targetData.members = membersWithIndex.map(({ name }) => ({ name }));

  Object.values(targetData.years || {}).forEach((yearData) => {
    if (yearData.vacationDays) {
      const reorderedVacationDays = {};
      Object.entries(yearData.vacationDays).forEach(([memberIndex, value]) => {
        const newIndex = indexMap.get(Number(memberIndex));
        if (newIndex !== undefined) {
          reorderedVacationDays[newIndex] = value;
        }
      });
      yearData.vacationDays = reorderedVacationDays;
    }
    if (!yearData.months) {
      return;
    }
    Object.values(yearData.months).forEach((month) => {
      if (!month || !month.days) {
        return;
      }
      const reordered = {};
      Object.entries(month.days).forEach(([memberIndex, days]) => {
        const newIndex = indexMap.get(Number(memberIndex));
        if (newIndex !== undefined) {
          reordered[newIndex] = days;
        }
      });
      month.days = reordered;
      if (month.approved) {
        const reorderedApproved = {};
        Object.entries(month.approved).forEach(([memberIndex, days]) => {
          const newIndex = indexMap.get(Number(memberIndex));
          if (newIndex !== undefined) {
            reorderedApproved[newIndex] = days;
          }
        });
        month.approved = reorderedApproved;
      }
    });
  });
}

export function migrateHalfDayStatuses(daysByMember) {
  Object.values(daysByMember).forEach((days) => {
    if (!days) {
      return;
    }
    Object.entries(days).forEach(([day, value]) => {
      if (value === "urlaub-half") {
        days[day] = "urlaub-am";
      }
    });
  });
}
