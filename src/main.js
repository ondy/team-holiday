import {
  CELL_BOX_EXTRA,
  CELL_HORIZONTAL_BORDER,
  CELL_HORIZONTAL_PADDING,
  MEMBER_COLUMN_WIDTH,
  METRIC_COLUMN_WIDTH,
  MIN_DAY_CELL_WIDTH,
  monthNames,
  schoolHolidayStates,
  statusOptions,
} from "./constants.js";
import { updateHolidayMaps } from "./holidays.js";
import { applySnapshot, loadData, normalizeData, saveData, snapshotData, sortMembersAndReindex } from "./storage.js";

const now = new Date();
const currentYear = now.getFullYear();
const currentMonthIndex = now.getMonth();
const currentDay = now.getDate();
let activeMonth = 0;
let activeYear = currentYear;
const statusLabelMap = new Map(statusOptions.map((option) => [option.value, option.label]));

const data = loadData(currentYear);
const schoolHolidayDates = new Set();
const schoolHolidayInfoMap = new Map();
const schoolHolidayStateStorageKey = "schoolHolidayState";
const schoolHolidayLoadedYears = new Set();
let schoolHolidayRequestId = 0;
let activeSchoolHolidayState = "NW";
let loadedSchoolHolidayState = "NW";
const undoStack = [];
const redoStack = [];
let isSelecting = false;
let lastSelectionEvent = null;
let selectionStart = null;
let selectionEnd = null;
const selectedCells = new Map();
let activeTable = null;
let justOpenedMenu = false;
let resizeTimer = null;

const buildInfo = document.getElementById("build-info");
if (buildInfo) {
  const branchName = __BUILD_BRANCH__.split("/").filter(Boolean).pop() ?? __BUILD_BRANCH__;
  const buildDate = new Date(__BUILD_TIME__);
  const timeLabel = Number.isNaN(buildDate.valueOf())
    ? __BUILD_TIME__
    : buildDate.toLocaleString("de-DE", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      });
  buildInfo.textContent = `${branchName} • ${timeLabel}`;
}

const legendItemsByStatus = new Map(
  Array.from(document.querySelectorAll(".legend-item[data-status]")).map((item) => [item.dataset.status, item])
);

const schoolHolidayStateSelect = document.getElementById("school-holiday-state");
const validSchoolHolidayStates = new Set(schoolHolidayStates.map((state) => state.code));
const schoolHolidayStateByCode = new Map(schoolHolidayStates.map((state) => [state.code, state]));
const storedSchoolHolidayState = localStorage.getItem(schoolHolidayStateStorageKey);
if (storedSchoolHolidayState && validSchoolHolidayStates.has(storedSchoolHolidayState)) {
  activeSchoolHolidayState = storedSchoolHolidayState;
}
loadedSchoolHolidayState = activeSchoolHolidayState;

if (schoolHolidayStateSelect) {
  schoolHolidayStateSelect.innerHTML = "";
  schoolHolidayStates.forEach((state) => {
    const option = document.createElement("option");
    option.value = state.code;
    option.textContent = state.name;
    if (state.code === activeSchoolHolidayState) {
      option.selected = true;
    }
    schoolHolidayStateSelect.appendChild(option);
  });
  schoolHolidayStateSelect.addEventListener("change", () => {
    activeSchoolHolidayState = schoolHolidayStateSelect.value;
    localStorage.setItem(schoolHolidayStateStorageKey, activeSchoolHolidayState);
    loadSchoolHolidaysForYears(getSchoolHolidayYearsToLoad(), activeSchoolHolidayState, { reset: true });
  });
}

function setLegendHighlight(status, isActive) {
  const item = legendItemsByStatus.get(status);
  if (!item) {
    return;
  }
  item.classList.toggle("is-highlighted", isActive);
}

function recordUndoState() {
  undoStack.push(snapshotData(data));
  redoStack.length = 0;
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  const undoButton = document.getElementById("undo-button");
  const redoButton = document.getElementById("redo-button");
  const exportButton = document.getElementById("export-button");
  const shareButton = document.getElementById("share-button");
  undoButton.disabled = undoStack.length === 0;
  redoButton.disabled = redoStack.length === 0;
  exportButton.disabled = data.members.length === 0;
  shareButton.disabled = data.members.length === 0;
}

function handleUndo() {
  if (!undoStack.length) {
    return;
  }
  redoStack.push(snapshotData(data));
  const snapshot = undoStack.pop();
  applySnapshot(snapshot, data);
  saveData(data);
  renderCalendar();
  updateUndoRedoButtons();
}

function handleRedo() {
  if (!redoStack.length) {
    return;
  }
  undoStack.push(snapshotData(data));
  const snapshot = redoStack.pop();
  applySnapshot(snapshot, data);
  saveData(data);
  renderCalendar();
  updateUndoRedoButtons();
}

function downloadExport() {
  const exportPayload = JSON.stringify(data, null, 2);
  const blob = new Blob([exportPayload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const timestamp = new Date().toISOString().slice(0, 10);
  link.download = `urlaubsplanung-${timestamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function base64FromBytes(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}

function bytesFromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function compressString(value) {
  if (typeof CompressionStream === "undefined") {
    throw new Error("Compression not supported");
  }
  const encoded = new TextEncoder().encode(value);
  const stream = new Blob([encoded]).stream().pipeThrough(new CompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

async function decompressToString(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Decompression not supported");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new TextDecoder().decode(buffer);
}

async function createShareUrl() {
  const payload = JSON.stringify(data);
  const compressed = await compressString(payload);
  const encoded = base64FromBytes(compressed);
  const url = new URL(window.location.href);
  url.hash = new URLSearchParams({ data: encoded }).toString();
  return url.toString();
}

function showShareDialog(value) {
  const dialog = document.getElementById("share-dialog");
  const input = document.getElementById("share-url");
  if (input) {
    input.value = value;
    input.focus();
    input.select();
  }
  if (!dialog || typeof dialog.showModal !== "function") {
    window.prompt(
      "Diese URL teilen, um alle eingegebenen Daten an eine andere Person zu schicken:",
      value
    );
    return;
  }
  dialog.showModal();
}

function isImportPayload(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  return (
    Object.hasOwn(value, "members") ||
    Object.hasOwn(value, "years") ||
    Object.hasOwn(value, "months")
  );
}

function mergeImportedData(importedData) {
  const importIndexMap = new Map();
  importedData.members.forEach((member, index) => {
    data.members.push({ name: member.name || "" });
    importIndexMap.set(index, data.members.length - 1);
  });

  Object.entries(importedData.years || {}).forEach(([year, yearData]) => {
    if (!data.years[year]) {
      data.years[year] = { months: {}, vacationDays: {} };
    }
    const targetYear = data.years[year];
    if (!targetYear.months) {
      targetYear.months = {};
    }
    if (!targetYear.vacationDays) {
      targetYear.vacationDays = {};
    }

    if (yearData?.vacationDays) {
      Object.entries(yearData.vacationDays).forEach(([memberIndex, value]) => {
        const targetIndex = importIndexMap.get(Number(memberIndex));
        if (targetIndex === undefined || value === undefined || value === null) {
          return;
        }
        targetYear.vacationDays[targetIndex] = value;
      });
    }

    Object.entries(yearData?.months || {}).forEach(([monthIndex, monthData]) => {
      if (!targetYear.months[monthIndex]) {
        targetYear.months[monthIndex] = { days: {}, approved: {} };
      }
      const targetMonth = targetYear.months[monthIndex];
      if (!targetMonth.days) {
        targetMonth.days = {};
      }
      if (!targetMonth.approved) {
        targetMonth.approved = {};
      }

      Object.entries(monthData?.days || {}).forEach(([memberIndex, days]) => {
        const targetIndex = importIndexMap.get(Number(memberIndex));
        if (targetIndex === undefined) {
          return;
        }
        if (!targetMonth.days[targetIndex]) {
          targetMonth.days[targetIndex] = {};
        }
        Object.entries(days || {}).forEach(([day, status]) => {
          targetMonth.days[targetIndex][day] = status;
        });
      });

      Object.entries(monthData?.approved || {}).forEach(([memberIndex, days]) => {
        const targetIndex = importIndexMap.get(Number(memberIndex));
        if (targetIndex === undefined) {
          return;
        }
        if (!targetMonth.approved[targetIndex]) {
          targetMonth.approved[targetIndex] = {};
        }
        Object.entries(days || {}).forEach(([day, status]) => {
          targetMonth.approved[targetIndex][day] = status;
        });
      });
    });
  });

  sortMembersAndReindex(data);
}

function isDataEmpty() {
  return data.members.length === 0;
}

function requestImportMode() {
  const dialog = document.getElementById("import-dialog");
  if (!dialog || typeof dialog.showModal !== "function") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const handleClose = () => {
      dialog.removeEventListener("close", handleClose);
      resolve(dialog.returnValue);
    };
    dialog.addEventListener("close", handleClose, { once: true });
    dialog.returnValue = "cancel";
    dialog.showModal();
  });
}

async function importPayload(parsed) {
  if (!isImportPayload(parsed)) {
    window.alert("Die gewählten Daten konnten nicht verarbeitet werden.");
    return false;
  }
  const normalized = normalizeData(parsed, currentYear);
  let mode = "overwrite";
  if (!isDataEmpty()) {
    mode = await requestImportMode();
    if (mode !== "overwrite" && mode !== "merge") {
      return false;
    }
  }
  recordUndoState();
  if (mode === "overwrite") {
    applySnapshot(JSON.stringify(normalized), data);
  } else {
    mergeImportedData(normalized);
  }
  saveData(data);
  renderCalendar();
  updateUndoRedoButtons();
  loadSchoolHolidaysForYears(getSchoolHolidayYearsToLoad(), activeSchoolHolidayState, { reset: true });
  return true;
}

async function handleImportFile(file) {
  if (!file) {
    return;
  }
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    await importPayload(parsed);
  } catch (error) {
    window.alert("Beim Importieren der Datei ist ein Fehler aufgetreten.");
  }
}

async function handleImportFromShare(value) {
  if (!value) {
    return;
  }
  try {
    const bytes = bytesFromBase64(value);
    const jsonText = await decompressToString(bytes);
    const parsed = JSON.parse(jsonText);
    const imported = await importPayload(parsed);
    if (imported) {
      const url = new URL(window.location.href);
      url.hash = "";
      window.history.replaceState(null, "", url.toString());
    }
  } catch (error) {
    window.alert("Beim Importieren der geteilten Daten ist ein Fehler aufgetreten.");
  }
}

function getShareDataFromUrl() {
  if (!window.location.hash) {
    return null;
  }
  const params = new URLSearchParams(window.location.hash.slice(1));
  return params.get("data");
}

function getSchoolHolidayStorageKey(year, state) {
  return `schoolHolidays_${state}_${year}`;
}

function parseHolidayDate(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  if (typeof value === "object") {
    if (typeof value.date === "string") {
      const parsed = new Date(value.date);
      return Number.isFinite(parsed.getTime()) ? parsed : null;
    }
    if (typeof value.iso === "string") {
      const parsed = new Date(value.iso);
      return Number.isFinite(parsed.getTime()) ? parsed : null;
    }
  }
  return null;
}

function resolveHolidayName(entry) {
  if (!entry) {
    return "Ferien";
  }
  if (typeof entry.name === "string" && entry.name.trim()) {
    return entry.name;
  }
  if (entry.name && typeof entry.name.text === "string" && entry.name.text.trim()) {
    return entry.name.text;
  }
  if (Array.isArray(entry.name)) {
    const germanName = entry.name.find((item) => item?.language === "DE" || item?.language === "de");
    if (germanName?.text) {
      return germanName.text;
    }
    const firstName = entry.name.find((item) => item?.text);
    if (firstName?.text) {
      return firstName.text;
    }
  }
  if (typeof entry.type === "string" && entry.type.trim()) {
    return entry.type;
  }
  return "Ferien";
}

function normalizeHolidayEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries
    .map((entry) => {
      const start = parseHolidayDate(entry?.startDate ?? entry?.start);
      const end = parseHolidayDate(entry?.endDate ?? entry?.end);
      if (!start || !end) {
        return null;
      }
      return {
        name: resolveHolidayName(entry),
        start: start.toISOString(),
        end: end.toISOString(),
      };
    })
    .filter(Boolean);
}

function fetchSchoolHolidaysFallback(year, state) {
  return fetch(`https://ferien-api.de/api/v1/holidays/${state}/${year}`)
    .then((response) => {
      if (!response.ok) {
        throw new Error("Unable to load school holidays");
      }
      return response.json();
    })
    .then((entries) => normalizeHolidayEntries(entries))
    .catch(() => null);
}

function loadSchoolHolidays(year, state) {
  const cached = localStorage.getItem(getSchoolHolidayStorageKey(year, state));
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      return Promise.resolve(normalizeHolidayEntries(parsed));
    } catch (error) {
      localStorage.removeItem(getSchoolHolidayStorageKey(year, state));
    }
  }

  const subdivisionCode = schoolHolidayStateByCode.get(state)?.subdivisionCode ?? `DE-${state}`;
  const fromDate = `${year}-01-01`;
  const toDate = `${year}-12-31`;

  return fetch(
    `https://openholidaysapi.org/SchoolHolidays?countryIsoCode=DE&subdivisionCode=${subdivisionCode}&validFrom=${fromDate}&validTo=${toDate}&languageIsoCode=DE`
  )
    .then((response) => {
      if (!response.ok) {
        throw new Error("Unable to load school holidays");
      }
      return response.json();
    })
    .then((entries) => {
      const normalized = normalizeHolidayEntries(entries);
      if (!normalized.length) {
        throw new Error("No entries from primary source");
      }
      localStorage.setItem(getSchoolHolidayStorageKey(year, state), JSON.stringify(normalized));
      return normalized;
    })
    .catch(() => fetchSchoolHolidaysFallback(year, state))
    .then((fallbackEntries) => {
      if (!fallbackEntries) {
        return null;
      }
      localStorage.setItem(getSchoolHolidayStorageKey(year, state), JSON.stringify(fallbackEntries));
      return fallbackEntries;
    })
    .catch(() => null);
}

function formatHolidayDate(date) {
  return `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}.${date.getFullYear()}`;
}

function clearSchoolHolidays() {
  schoolHolidayDates.clear();
  schoolHolidayInfoMap.clear();
}

function applySchoolHolidays(entries) {
  if (!Array.isArray(entries)) {
    return;
  }
  entries.forEach((entry) => {
    const name = entry?.name || entry?.type || "Ferien";
    const start = new Date(entry.start);
    const end = new Date(entry.end);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
      return;
    }
    const holidayLabel = `${name} (${formatHolidayDate(start)} - ${formatHolidayDate(end)})`;
    for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      schoolHolidayDates.add(key);
      const existingLabel = schoolHolidayInfoMap.get(key);
      if (existingLabel) {
        if (!existingLabel.includes(holidayLabel)) {
          schoolHolidayInfoMap.set(key, `${existingLabel}\n${holidayLabel}`);
        }
      } else {
        schoolHolidayInfoMap.set(key, holidayLabel);
      }
    }
  });
}

function getSchoolHolidayYearsToLoad() {
  const years = new Set(
    Object.keys(data.years)
      .map((year) => Number(year))
      .filter((year) => Number.isFinite(year))
  );
  years.add(currentYear);
  years.add(currentYear + 1);
  years.add(activeYear);
  return years;
}

function resetSchoolHolidayCache() {
  clearSchoolHolidays();
  schoolHolidayLoadedYears.clear();
  loadedSchoolHolidayState = activeSchoolHolidayState;
}

function loadSchoolHolidaysForYears(years, state, { reset = false } = {}) {
  if (reset || state !== loadedSchoolHolidayState) {
    resetSchoolHolidayCache();
    renderCalendar();
  }

  const yearsToLoad = [...years].filter((year) => !schoolHolidayLoadedYears.has(year));
  if (!yearsToLoad.length) {
    renderCalendar();
    return Promise.resolve();
  }

  const requestId = ++schoolHolidayRequestId;
  return Promise.all(yearsToLoad.map((year) => loadSchoolHolidays(year, state))).then((entriesByYear) => {
    if (requestId !== schoolHolidayRequestId) {
      return;
    }
    entriesByYear.forEach((entries, index) => {
      if (!entries) {
        return;
      }
      applySchoolHolidays(entries);
      schoolHolidayLoadedYears.add(yearsToLoad[index]);
    });
    renderCalendar();
  });
}

function getMonthData(year, monthIndex) {
  const yearData = getYearData(year);
  if (!yearData.months[monthIndex]) {
    yearData.months[monthIndex] = { days: {}, approved: {} };
  } else if (!yearData.months[monthIndex].days) {
    yearData.months[monthIndex].days = {};
  }
  if (!yearData.months[monthIndex].approved) {
    yearData.months[monthIndex].approved = {};
  }
  return yearData.months[monthIndex];
}

function getYearData(year) {
  if (!data.years[year]) {
    const closestYear = findClosestYearWithVacationDays(year);
    data.years[year] = {
      months: {},
      vacationDays: closestYear ? { ...data.years[closestYear].vacationDays } : {},
    };
  }
  const yearData = data.years[year];
  if (!yearData.months) {
    yearData.months = {};
  }
  if (!yearData.vacationDays) {
    const closestYear = findClosestYearWithVacationDays(year);
    yearData.vacationDays = closestYear ? { ...data.years[closestYear].vacationDays } : {};
  }
  return yearData;
}

function findClosestYearWithVacationDays(targetYear) {
  const years = Object.keys(data.years)
    .map((year) => Number(year))
    .filter((year) => Number.isFinite(year) && data.years[year]?.vacationDays);
  if (!years.length) {
    return null;
  }
  return years.reduce((closest, year) => {
    if (closest === null) {
      return year;
    }
    const distance = Math.abs(year - targetYear);
    const closestDistance = Math.abs(closest - targetYear);
    if (distance < closestDistance) {
      return year;
    }
    if (distance === closestDistance) {
      return year < closest ? year : closest;
    }
    return closest;
  }, null);
}

function parseVacationValue(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatCount(value) {
  if (!value) {
    return "";
  }
  const formatted = Number.isInteger(value) ? String(value) : String(value).replace(".", ",");
  return formatted;
}

function isExcludedVacationDay(year, monthIndex, day) {
  const date = new Date(year, monthIndex, day);
  const isWeekend = [0, 6].includes(date.getDay());
  const dateKey = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const isHoliday = holidaySet.has(dateKey);
  return isWeekend || isHoliday;
}

function getYearStatusCounts(year) {
  const countsByMember = data.members.map(() => ({
    urlaub: 0,
    sonderurlaub: 0,
    krank: 0,
    schulung: 0,
    einsatz: 0,
    gleittag: 0,
  }));
  const yearData = getYearData(year);
  Object.entries(yearData.months || {}).forEach(([monthIndex, month]) => {
    if (!month || !month.days) {
      return;
    }
    const monthNumber = Number(monthIndex);
    Object.entries(month.days).forEach(([memberIndex, days]) => {
      const memberCounts = countsByMember[Number(memberIndex)];
      if (!memberCounts || !days) {
        return;
      }
      Object.entries(days).forEach(([day, status]) => {
        const dayNumber = Number(day);
        const shouldSkipVacation = isExcludedVacationDay(year, monthNumber, dayNumber);
        switch (status) {
          case "urlaub":
            if (!shouldSkipVacation) {
              memberCounts.urlaub += 1;
            }
            break;
          case "sonderurlaub":
            if (!shouldSkipVacation) {
              memberCounts.sonderurlaub += 1;
            }
            break;
          case "urlaub-am":
          case "urlaub-pm":
            if (!shouldSkipVacation) {
              memberCounts.urlaub += 0.5;
            }
            break;
          case "krank":
            memberCounts.krank += 1;
            break;
          case "schulung":
            memberCounts.schulung += 1;
            break;
          case "einsatz":
            memberCounts.einsatz += 1;
            break;
          case "gleittag":
            memberCounts.gleittag += 1;
            break;
          default:
            break;
        }
      });
    });
  });
  return countsByMember;
}

function getDaysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

const holidaySet = new Set();
const holidayNameMap = new Map();

updateHolidayMaps(activeYear, holidaySet, holidayNameMap);

const metricColumns = [
  { key: "vacationDays", label: "Urlaubstage", editable: true, width: 52 },
  { key: "urlaub", label: "Urlaub", width: 26 },
  { key: "sonderurlaub", label: "Sonderurlaub", width: 26 },
  { key: "krank", label: "Krank", width: 26 },
  { key: "schulung", label: "Schulung", width: 26 },
  { key: "einsatz", label: "Einsatz", width: 26 },
  { key: "gleittag", label: "Gleittag", width: 26 },
];

function buildTabs() {
  const container = document.getElementById("month-tabs");
  container.innerHTML = "";
  monthNames.forEach((name, index) => {
    const button = document.createElement("button");
    const isActive = index === activeMonth;
    const isCurrentMonth = index === currentMonthIndex && activeYear === currentYear;
    button.className = "tab-button" + (isActive ? " active" : "") + (isCurrentMonth ? " current-month" : "");
    button.textContent = name;
    button.addEventListener("click", () => {
      activeMonth = index;
      renderCalendar();
    });
    container.appendChild(button);
  });
}

function renderCalendar() {
  buildTabs();
  const title = document.getElementById("page-title");
  title.textContent = `${activeYear}`;
  const container = document.getElementById("calendar-container");
  container.innerHTML = "";

  const yearData = getYearData(activeYear);
  const monthData = getMonthData(activeYear, activeMonth);
  const daysInMonth = getDaysInMonth(activeYear, activeMonth);
  const dayColumns = buildDayColumns(activeYear, activeMonth);
  const layout = getTableLayout(container);
  const yearCounts = getYearStatusCounts(activeYear);

  container.style.setProperty("--day-cell-width", `${layout.dayCellWidth}px`);
  const tableSegments = splitDayColumns(dayColumns, layout.maxColumnsPerTable);

  tableSegments.forEach((segment, segmentIndex) => {
    const allowMemberEdit = segmentIndex === 0;
    const includeNewRow = segmentIndex === 0;
    const wrapper = document.createElement("div");
    wrapper.className = "table-wrapper";
    const table = buildTable(segment, {
      allowMemberEdit,
      includeNewRow,
      yearData,
      yearCounts,
      monthData,
      dayCellWidth: layout.dayCellWidth,
    });
    wrapper.appendChild(table);
    container.appendChild(wrapper);
    addTableHoverHighlights(table);
    renderTodayColumnHighlight(wrapper, table, daysInMonth);
  });

  activeTable = null;
  clearSelection();
}

function getTableLayout(container) {
  const containerWidth = container.clientWidth || container.getBoundingClientRect().width || window.innerWidth;
  const metricWidth = metricColumns.reduce((total, column) => total + (column.width || METRIC_COLUMN_WIDTH), 0);
  const availableWidth = Math.max(0, containerWidth - MEMBER_COLUMN_WIDTH - metricWidth);
  const minCellTotal = MIN_DAY_CELL_WIDTH + CELL_BOX_EXTRA;
  const maxColumnsPerTable = Math.max(2, Math.floor(availableWidth / minCellTotal) || 1);
  const usableWidth = Math.max(0, availableWidth - maxColumnsPerTable * CELL_BOX_EXTRA);
  const dayCellWidth = Math.max(24, Math.floor(usableWidth / maxColumnsPerTable));
  return { maxColumnsPerTable, dayCellWidth };
}

function splitDayColumns(dayColumns, maxColumnsPerTable) {
  if (dayColumns.length <= maxColumnsPerTable) {
    return [dayColumns];
  }
  const prevColumn = dayColumns[0];
  const nextColumn = dayColumns[dayColumns.length - 1];
  const inMonthColumns = dayColumns.slice(1, -1);
  const segments = [];

  const firstChunkSize = Math.min(
    Math.max(1, maxColumnsPerTable - 1),
    Math.max(1, inMonthColumns.length - 1)
  );
  segments.push([prevColumn, ...inMonthColumns.slice(0, firstChunkSize)]);

  let startIndex = firstChunkSize;
  while (startIndex < inMonthColumns.length) {
    const remaining = inMonthColumns.length - startIndex;
    if (remaining <= maxColumnsPerTable - 1) {
      segments.push([...inMonthColumns.slice(startIndex), nextColumn]);
      break;
    }
    segments.push(inMonthColumns.slice(startIndex, startIndex + maxColumnsPerTable));
    startIndex += maxColumnsPerTable;
  }
  return segments;
}

function buildTable(dayColumns, { allowMemberEdit, includeNewRow, monthData, yearData, yearCounts, dayCellWidth }) {
  const table = document.createElement("table");
  const metricWidth = metricColumns.reduce((total, column) => total + (column.width || METRIC_COLUMN_WIDTH), 0);
  const tableWidth = MEMBER_COLUMN_WIDTH + metricWidth + dayCellWidth * dayColumns.length;
  table.style.width = `${tableWidth}px`;
  table.style.minWidth = `${tableWidth}px`;
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  const memberHeader = document.createElement("th");
  memberHeader.className = "member-column";
  memberHeader.textContent = "";
  memberHeader.dataset.col = "member";
  headerRow.appendChild(memberHeader);

  metricColumns.forEach((column) => {
    const th = document.createElement("th");
    th.className = "metric-cell metric-header";
    th.dataset.col = `metric-${column.key}`;
    const columnWidth = column.width || METRIC_COLUMN_WIDTH;
    th.style.width = `${columnWidth}px`;
    th.style.minWidth = `${columnWidth}px`;
    const label = document.createElement("span");
    label.textContent = column.label;
    th.appendChild(label);
    headerRow.appendChild(th);
  });

  dayColumns.forEach((dayInfo, columnIndex) => {
    const th = document.createElement("th");
    th.className = "day-cell";
    const baseLabel = `${String(dayInfo.day).padStart(2, "0")}.${String(dayInfo.month).padStart(2, "0")}`;
    const dayLabel = baseLabel;
    const weekday = dayInfo.date.toLocaleDateString("de-DE", { weekday: "short" });
    th.innerHTML = `${dayLabel}<div class="day-short">${weekday}</div>`;
    th.dataset.col = `col-${columnIndex}`;
    if (dayInfo.inMonth) {
      th.dataset.day = String(dayInfo.day);
    }
    if (!dayInfo.inMonth) {
      th.classList.add("outside-month");
    }
    const holidayName = holidayNameMap.get(dayInfo.key);
    const schoolHolidayInfo = schoolHolidayInfoMap.get(dayInfo.key);
    if (holidayName || schoolHolidayInfo) {
      const titleParts = [];
      if (holidayName) {
        titleParts.push(holidayName);
      }
      if (schoolHolidayInfo) {
        titleParts.push(schoolHolidayInfo);
      }
      th.title = titleParts.join("\n");
    }
    if (dayInfo.position === "start") {
      th.classList.add("month-boundary-left");
    }
    if (dayInfo.position === "end") {
      th.classList.add("month-boundary-right");
    }
    headerRow.appendChild(th);
  });

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const rows = [...data.members];
  if (includeNewRow) {
    rows.push({ name: "" });
  }

  rows.forEach((member, index) => {
    const memberCounts = yearCounts?.[index];
    const tr = document.createElement("tr");
    tr.className = "member-row";
    if (index >= data.members.length) {
      tr.classList.add("new-member-row");
    }

    const nameCell = document.createElement("td");
    nameCell.className = allowMemberEdit ? "member-column member-input" : "member-column";
    nameCell.dataset.col = "member";
    const nameSpan = document.createElement("span");
    nameSpan.className = "member-name";
    nameSpan.textContent = member.name || "";
    nameCell.appendChild(nameSpan);
    if (allowMemberEdit) {
      nameCell.addEventListener("click", () => editMemberName(nameCell, index));
    }
    if (allowMemberEdit && index < data.members.length) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "delete-button";
      deleteButton.textContent = "Löschen";
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        removeMember(index);
      });
      nameCell.appendChild(deleteButton);
    } else if (allowMemberEdit && index >= data.members.length) {
      createMemberInput(nameCell, index, "");
    }
    tr.appendChild(nameCell);

    metricColumns.forEach((column) => {
      const td = document.createElement("td");
      td.className = "metric-cell";
      td.dataset.col = `metric-${column.key}`;
      const columnWidth = column.width || METRIC_COLUMN_WIDTH;
      td.style.width = `${columnWidth}px`;
      td.style.minWidth = `${columnWidth}px`;
      if (column.editable) {
        if (index < data.members.length) {
          const input = document.createElement("input");
          input.type = "number";
          input.className = "metric-input";
          input.min = "0";
          input.step = "0.5";
          const storedValue = yearData?.vacationDays?.[index];
          const currentValue = Number(storedValue);
          input.value = Number.isFinite(currentValue) ? String(currentValue) : "";
          input.addEventListener("change", () => {
            const nextValue = parseVacationValue(input.value);
            const previousValue = Number.isFinite(currentValue) ? currentValue : null;
            if (nextValue === previousValue) {
              return;
            }
            recordUndoState();
            if (nextValue === null) {
              delete yearData.vacationDays[index];
            } else {
              yearData.vacationDays[index] = nextValue;
            }
            saveData(data);
            renderCalendar();
          });
          td.appendChild(input);
        }
      } else if (memberCounts) {
        td.textContent = formatCount(memberCounts[column.key]);
      }
      tr.appendChild(td);
    });

    dayColumns.forEach((dayInfo, columnIndex) => {
      const td = document.createElement("td");
      td.className = "cell day-cell";
      td.dataset.col = `col-${columnIndex}`;
      if (!dayInfo.inMonth) {
        td.classList.add("outside-month");
      }
      if (dayInfo.position === "start") {
        td.classList.add("month-boundary-left");
      }
      if (dayInfo.position === "end") {
        td.classList.add("month-boundary-right");
      }
      const dateKey = dayInfo.key;
      const isWeekend = [0, 6].includes(dayInfo.date.getDay());
      const isHoliday = holidaySet.has(dateKey);

      const targetMonthData = getMonthData(dayInfo.year, dayInfo.monthIndex);
      const status = targetMonthData.days?.[index]?.[dayInfo.day];
      if (isHoliday) {
        td.classList.add("holiday");
      } else if (isWeekend) {
        td.classList.add("weekend");
      } else if (schoolHolidayDates.has(dateKey)) {
        td.classList.add("school-holiday");
      }
      if (status) {
        td.classList.add(`status-${status}`);
        td.dataset.status = status;
        const statusLabel = statusLabelMap.get(status);
        if (statusLabel) {
          td.title = statusLabel;
        }
      }

      if (status && isVacationStatus(status)) {
        td.classList.add("vacation-cell");
        if (targetMonthData.approved?.[index]?.[dayInfo.day]) {
          td.classList.add("vacation-approved");
        }
        if (dayInfo.inMonth) {
          const approvalToggle = document.createElement("label");
          approvalToggle.className = "approval-toggle";
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = Boolean(targetMonthData.approved?.[index]?.[dayInfo.day]);
          checkbox.addEventListener("mousedown", (event) => {
            event.stopPropagation();
          });
          checkbox.addEventListener("click", (event) => {
            event.stopPropagation();
            toggleVacationApproval(index, dayInfo.day);
          });
          approvalToggle.appendChild(checkbox);
          td.appendChild(approvalToggle);
        }
      }

      if (dayInfo.inMonth) {
        td.dataset.memberIndex = index;
        td.dataset.day = dayInfo.day;
        td.addEventListener("mousedown", (event) => handleCellMouseDown(event, td));
        td.addEventListener("mouseover", () => handleCellMouseOver(td));
        if (status) {
          td.addEventListener("mouseenter", () => setLegendHighlight(status, true));
          td.addEventListener("mouseleave", () => setLegendHighlight(status, false));
        }
      }
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);

  const tfoot = document.createElement("tfoot");
  const summaryRow = document.createElement("tr");
  const summaryLabel = document.createElement("td");
  summaryLabel.className = "member-column mini-cell";
  summaryLabel.textContent = "";
  summaryRow.appendChild(summaryLabel);
  metricColumns.forEach((column) => {
    const summaryCell = document.createElement("td");
    summaryCell.className = "mini-cell metric-cell";
    summaryCell.dataset.col = `metric-${column.key}`;
    const columnWidth = column.width || METRIC_COLUMN_WIDTH;
    summaryCell.style.width = `${columnWidth}px`;
    summaryCell.style.minWidth = `${columnWidth}px`;
    summaryRow.appendChild(summaryCell);
  });
  dayColumns.forEach((dayInfo, columnIndex) => {
    const summaryCell = document.createElement("td");
    summaryCell.className = "mini-cell day-cell";
    summaryCell.dataset.col = `col-${columnIndex}`;
    if (dayInfo.inMonth) {
      const count = data.members.reduce((total, _member, memberIndex) => {
        const value = monthData.days?.[memberIndex]?.[dayInfo.day];
        return value ? total + 1 : total;
      }, 0);
      summaryCell.textContent = count ? String(count) : "";
    } else {
      summaryCell.textContent = "";
    }
    summaryRow.appendChild(summaryCell);
  });
  tfoot.appendChild(summaryRow);
  table.appendChild(tfoot);

  return table;
}

function buildDayColumns(year, monthIndex) {
  const daysInMonth = getDaysInMonth(year, monthIndex);
  const prevMonthDate = new Date(year, monthIndex, 0);
  const prevDay = prevMonthDate.getDate();
  const nextMonthDate = new Date(year, monthIndex + 1, 1);
  const columns = [];

  const addColumn = (date, inMonth, day, position = "") => {
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    columns.push({
      date,
      key,
      inMonth,
      day,
      month: date.getMonth() + 1,
      monthIndex: date.getMonth(),
      year: date.getFullYear(),
      colKey: `col-${columns.length}`,
      position,
    });
  };

  addColumn(new Date(year, monthIndex - 1, prevDay), false, prevDay, "before");
  for (let day = 1; day <= daysInMonth; day += 1) {
    const position = day === 1 ? "start" : day === daysInMonth ? "end" : "";
    addColumn(new Date(year, monthIndex, day), true, day, position);
  }
  addColumn(new Date(year, monthIndex + 1, 1), false, 1, "after");

  return columns;
}

function renderTodayColumnHighlight(wrapper, table, daysInMonth) {
  if (activeYear !== currentYear || activeMonth !== currentMonthIndex || currentDay > daysInMonth) {
    return;
  }
  const headerCell = table.querySelector(`th[data-day="${currentDay}"]`);
  if (!headerCell) {
    return;
  }
  const highlight = document.createElement("div");
  highlight.className = "today-column-highlight";
  wrapper.appendChild(highlight);
  window.requestAnimationFrame(() => {
    const wrapperRect = wrapper.getBoundingClientRect();
    const cellRect = headerCell.getBoundingClientRect();
    const left = cellRect.left - wrapperRect.left;
    highlight.style.left = `${left}px`;
    highlight.style.width = `${cellRect.width}px`;
  });
}

function finalizeMemberInput(cell, index, input) {
  const name = input.value.trim();
  const isExisting = index < data.members.length;
  const previousName = isExisting ? data.members[index].name : "";
  if (!name && !isExisting) {
    renderCalendar();
    return;
  }
  if (isExisting && name === previousName) {
    renderCalendar();
    return;
  }
  recordUndoState();
  if (isExisting) {
    data.members[index].name = name;
  } else {
    data.members.push({ name });
  }

  sortMembersAndReindex(data);
  saveData(data);
  renderCalendar();
}

function createMemberInput(cell, index, initialValue = "") {
  const wrapper = document.createElement("div");
  wrapper.className = "input-wrapper";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Name eingeben";
  input.value = initialValue;
  const okButton = document.createElement("button");
  okButton.type = "button";
  okButton.className = "ok-button";
  okButton.textContent = "OK";
  okButton.addEventListener("click", (event) => {
    event.stopPropagation();
    finalizeMemberInput(cell, index, input);
  });
  wrapper.appendChild(input);
  wrapper.appendChild(okButton);
  cell.textContent = "";
  cell.appendChild(wrapper);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      finalizeMemberInput(cell, index, input);
    }
  });
  input.addEventListener("blur", () => {
    if (index === data.members.length && !input.value.trim()) {
      cell.textContent = "";
      createMemberInput(cell, index, "");
    }
  });
  return input;
}

function editMemberName(cell, index) {
  if (cell.querySelector("input")) {
    return;
  }
  const existingValue = cell.querySelector(".member-name")?.textContent || "";
  const input = createMemberInput(cell, index, existingValue);
  input.focus();
  input.select();
}

function removeMember(index) {
  const member = data.members[index];
  if (!member) {
    return;
  }
  if (!window.confirm(`Möchtest du ${member.name || "dieses Team-Mitglied"} wirklich löschen?`)) {
    return;
  }
  recordUndoState();
  data.members.splice(index, 1);
  Object.values(data.years).forEach((yearData) => {
    if (!yearData.months) {
      return;
    }
    if (yearData.vacationDays) {
      const reorderedVacationDays = {};
      Object.entries(yearData.vacationDays).forEach(([memberIndex, value]) => {
        const numericIndex = Number(memberIndex);
        if (numericIndex < index) {
          reorderedVacationDays[numericIndex] = value;
        } else if (numericIndex > index) {
          reorderedVacationDays[numericIndex - 1] = value;
        }
      });
      yearData.vacationDays = reorderedVacationDays;
    }
    Object.values(yearData.months).forEach((month) => {
      if (!month || !month.days) {
        return;
      }
      const reordered = {};
      Object.entries(month.days).forEach(([memberIndex, days]) => {
        const numericIndex = Number(memberIndex);
        if (numericIndex < index) {
          reordered[numericIndex] = days;
        } else if (numericIndex > index) {
          reordered[numericIndex - 1] = days;
        }
      });
      month.days = reordered;
      if (month.approved) {
        const reorderedApproved = {};
        Object.entries(month.approved).forEach(([memberIndex, days]) => {
          const numericIndex = Number(memberIndex);
          if (numericIndex < index) {
            reorderedApproved[numericIndex] = days;
          } else if (numericIndex > index) {
            reorderedApproved[numericIndex - 1] = days;
          }
        });
        month.approved = reorderedApproved;
      }
    });
  });
  saveData(data);
  renderCalendar();
}

function openContextMenu(event, selection) {
  if (!selection.length) {
    return;
  }
  const monthData = getMonthData(activeYear, activeMonth);

  const menu = document.getElementById("context-menu");
  menu.innerHTML = "";

  statusOptions.forEach((option) => {
    if (option.requiresWeekendOrHoliday && !selection.every(({ day }) => isWeekendOrHoliday(day))) {
      return;
    }
    const button = document.createElement("button");
    const color = document.createElement("span");
    color.className = `color-dot ${option.className}`.trim();
    button.appendChild(color);
    button.append(option.label);
    button.addEventListener("click", () => {
      recordUndoState();
      selection.forEach(({ memberIndex, day }) => {
        if (!monthData.days[memberIndex]) {
          monthData.days[memberIndex] = {};
        }
        if (option.value) {
          monthData.days[memberIndex][day] = option.value;
        } else {
          delete monthData.days[memberIndex][day];
        }
      });
      saveData(data);
      menu.style.display = "none";
      renderCalendar();
    });
    menu.appendChild(button);
  });

  menu.style.top = `${event.pageY + 6}px`;
  menu.style.left = `${event.pageX + 6}px`;
  menu.style.display = "block";
  constrainMenuToViewport(menu);
  justOpenedMenu = true;
  window.setTimeout(() => {
    justOpenedMenu = false;
  }, 0);
}

function isWeekendOrHoliday(day) {
  const dateKey = `${activeYear}-${String(activeMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const isWeekend = [0, 6].includes(new Date(activeYear, activeMonth, day).getDay());
  const isHoliday = holidaySet.has(dateKey);
  return isWeekend || isHoliday;
}

function isVacationStatus(status) {
  return ["urlaub", "urlaub-am", "urlaub-pm", "sonderurlaub"].includes(status);
}

function constrainMenuToViewport(menu) {
  const rect = menu.getBoundingClientRect();
  let left = rect.left;
  let top = rect.top;
  const padding = 8;
  if (rect.right > window.innerWidth - padding) {
    left = window.innerWidth - rect.width - padding;
  }
  if (rect.bottom > window.innerHeight - padding) {
    top = window.innerHeight - rect.height - padding;
  }
  if (left < padding) {
    left = padding;
  }
  if (top < padding) {
    top = padding;
  }
  menu.style.left = `${left + window.scrollX}px`;
  menu.style.top = `${top + window.scrollY}px`;
}

function getVacationBlock(memberIndex, day, monthData) {
  let start = day;
  let end = day;
  while (start > 1 && isVacationStatus(monthData.days?.[memberIndex]?.[start - 1])) {
    start -= 1;
  }
  while (
    end < getDaysInMonth(activeYear, activeMonth) &&
    isVacationStatus(monthData.days?.[memberIndex]?.[end + 1])
  ) {
    end += 1;
  }
  return { start, end };
}

function toggleVacationApproval(memberIndex, day) {
  const monthData = getMonthData(activeYear, activeMonth);
  if (!isVacationStatus(monthData.days?.[memberIndex]?.[day])) {
    return;
  }
  recordUndoState();
  if (!monthData.approved[memberIndex]) {
    monthData.approved[memberIndex] = {};
  }
  const { start, end } = getVacationBlock(memberIndex, day, monthData);
  const shouldApprove = !monthData.approved[memberIndex][day];
  for (let currentDay = start; currentDay <= end; currentDay += 1) {
    if (shouldApprove) {
      monthData.approved[memberIndex][currentDay] = true;
    } else {
      delete monthData.approved[memberIndex][currentDay];
    }
  }
  if (Object.keys(monthData.approved[memberIndex]).length === 0) {
    delete monthData.approved[memberIndex];
  }
  saveData(data);
  renderCalendar();
}

function handleCellMouseDown(event, cell) {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  activeTable = cell.closest("table");
  clearSelection();
  isSelecting = true;
  lastSelectionEvent = event;
  selectionStart = getCellInfo(cell);
  selectionEnd = selectionStart;
  updateSelectionRectangle();
}

function handleCellMouseOver(cell) {
  if (!isSelecting) {
    return;
  }
  selectionEnd = getCellInfo(cell);
  updateSelectionRectangle();
}

function updateSelectionRectangle() {
  if (!selectionStart || !selectionEnd || !activeTable) {
    return;
  }
  clearSelectionCells();
  const minMember = Math.min(selectionStart.memberIndex, selectionEnd.memberIndex);
  const maxMember = Math.max(selectionStart.memberIndex, selectionEnd.memberIndex);
  const minDay = Math.min(selectionStart.day, selectionEnd.day);
  const maxDay = Math.max(selectionStart.day, selectionEnd.day);

  for (let memberIndex = minMember; memberIndex <= maxMember; memberIndex += 1) {
    for (let day = minDay; day <= maxDay; day += 1) {
      const cell = activeTable.querySelector(
        `td.cell[data-member-index="${memberIndex}"][data-day="${day}"]`
      );
      if (cell) {
        const info = getCellInfo(cell);
        if (!info || selectedCells.has(info.key)) {
          continue;
        }
        selectedCells.set(info.key, info);
        cell.classList.add("cell-selected");
      }
    }
  }
}

function clearSelectionCells() {
  selectedCells.forEach((info) => {
    info.cell.classList.remove("cell-selected");
  });
  selectedCells.clear();
}

function clearSelection() {
  clearSelectionCells();
  isSelecting = false;
  selectionStart = null;
  selectionEnd = null;
}

function getCellInfo(cell) {
  const memberIndex = Number(cell.dataset.memberIndex);
  const day = Number(cell.dataset.day);
  if (!Number.isFinite(memberIndex) || !Number.isFinite(day)) {
    return null;
  }
  if (!data.members[memberIndex]) {
    return null;
  }
  return {
    memberIndex,
    day,
    key: `${memberIndex}-${day}`,
    cell,
  };
}

function handleSelectionComplete(event) {
  if (!isSelecting) {
    return;
  }
  isSelecting = false;
  lastSelectionEvent = event;
  const selection = Array.from(selectedCells.values()).map(({ memberIndex, day }) => ({ memberIndex, day }));
  if (selection.length) {
    openContextMenu(lastSelectionEvent, selection);
  }
}

window.addEventListener("mouseup", handleSelectionComplete);

function addTableHoverHighlights(table) {
  const clearHighlights = () => {
    table.querySelectorAll(".row-highlight").forEach((row) => row.classList.remove("row-highlight"));
    table.querySelectorAll(".col-highlight").forEach((cell) => cell.classList.remove("col-highlight"));
  };

  table.addEventListener("mouseover", (event) => {
    const cell = event.target.closest("td");
    if (!cell) {
      return;
    }
    clearHighlights();
    const row = cell.parentElement;
    if (!row || row.classList.contains("new-member-row")) {
      return;
    }
    if (cell.classList.contains("mini-cell") || row.parentElement?.tagName === "TFOOT") {
      return;
    }
    row.classList.add("row-highlight");
    if (!cell.classList.contains("cell")) {
      return;
    }
    const colKey = cell.dataset.col;
    if (!colKey) {
      return;
    }
    table.querySelectorAll(`td.cell[data-col="${colKey}"]`).forEach((colCell) => {
      colCell.classList.add("col-highlight");
    });
  });

  table.addEventListener("mouseleave", () => {
    clearHighlights();
  });
}

document.addEventListener("click", (event) => {
  const menu = document.getElementById("context-menu");
  if (justOpenedMenu) {
    return;
  }
  if (!menu.contains(event.target) && !event.target.classList.contains("cell")) {
    menu.style.display = "none";
    clearSelection();
  }
});

function handleResize() {
  if (resizeTimer) {
    window.clearTimeout(resizeTimer);
  }
  resizeTimer = window.setTimeout(() => {
    renderCalendar();
  }, 120);
}

window.addEventListener("resize", handleResize);

function changeYear(delta) {
  activeYear += delta;
  activeMonth = delta > 0 ? 0 : 11;
  updateHolidayMaps(activeYear, holidaySet, holidayNameMap);
  renderCalendar();
  loadSchoolHolidaysForYears(getSchoolHolidayYearsToLoad(), activeSchoolHolidayState);
}

renderCalendar();
loadSchoolHolidaysForYears(getSchoolHolidayYearsToLoad(), activeSchoolHolidayState, { reset: true });

const undoButton = document.getElementById("undo-button");
const redoButton = document.getElementById("redo-button");
const exportButton = document.getElementById("export-button");
const importButton = document.getElementById("import-button");
const shareButton = document.getElementById("share-button");
const importFileInput = document.getElementById("import-file");
const prevYearButton = document.getElementById("prev-year");
const nextYearButton = document.getElementById("next-year");
undoButton.addEventListener("click", handleUndo);
redoButton.addEventListener("click", handleRedo);
exportButton.addEventListener("click", downloadExport);
importButton.addEventListener("click", () => {
  importFileInput.value = "";
  importFileInput.click();
});
shareButton.addEventListener("click", async () => {
  try {
    const shareUrl = await createShareUrl();
    showShareDialog(shareUrl);
  } catch (error) {
    window.alert("Teilen ist in diesem Browser leider nicht verfügbar.");
  }
});
importFileInput.addEventListener("change", (event) => {
  const [file] = event.target.files || [];
  handleImportFile(file);
});
prevYearButton.addEventListener("click", () => changeYear(-1));
nextYearButton.addEventListener("click", () => changeYear(1));
updateUndoRedoButtons();
void handleImportFromShare(getShareDataFromUrl());
