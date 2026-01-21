export const statusOptions = [
  { label: "nichts", value: "", className: "" },
  { label: "Urlaub", value: "urlaub", className: "status-urlaub" },
  { label: "Sonderurlaub", value: "sonderurlaub", className: "status-sonderurlaub" },
  { label: "Urlaub vormittags", value: "urlaub-am", className: "status-urlaub-am" },
  { label: "Urlaub nachmittags", value: "urlaub-pm", className: "status-urlaub-pm" },
  { label: "krank", value: "krank", className: "status-krank" },
  { label: "Schulung", value: "schulung", className: "status-schulung" },
  { label: "Einsatz", value: "einsatz", className: "status-einsatz", requiresWeekendOrHoliday: true },
  { label: "Gleittag", value: "gleittag", className: "status-gleittag" },
];

export const monthNames = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];

export const storageKey = "teamHolidayData";

export const MEMBER_COLUMN_WIDTH = 180;
export const METRIC_COLUMN_WIDTH = 36;
export const MIN_DAY_CELL_WIDTH = 34;
export const CELL_HORIZONTAL_PADDING = 8;
export const CELL_HORIZONTAL_BORDER = 2;
export const CELL_BOX_EXTRA = CELL_HORIZONTAL_PADDING + CELL_HORIZONTAL_BORDER;
