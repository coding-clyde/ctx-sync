/** Formatting helpers shared by the CLI and reports. */

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

export function formatNumber(value: number): string {
  return NUMBER_FORMAT.format(value);
}

/** Collapse all whitespace (including newlines) to single spaces. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncate(value: string, maximum: number): string {
  if (maximum <= 0) {
    return "";
  }
  if (value.length <= maximum) {
    return value;
  }
  if (maximum <= 3) {
    return value.slice(0, maximum);
  }
  return `${value.slice(0, maximum - 3)}...`;
}

export function plural(
  count: number,
  singular: string,
  pluralForm = `${singular}s`,
): string {
  return count === 1 ? singular : pluralForm;
}

/** Pad to a visible width without relying on terminal-specific libraries. */
export function padEnd(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export function padStart(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}
