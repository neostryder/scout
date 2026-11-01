export const riskLevelText = (level) => ({ low: "Low", moderate: "Moderate", elevated: "Elevated", high: "High" })[level] || "Unknown";

export function riskLabel(score, level) { return `Update risk ${score} of 100, ${String(level || "unknown")}`; }

export function riskRingMath(score, radius = 14, strokeWidth = 3) {
  const circumference = 2 * Math.PI * radius;
  const bounded = Math.max(0, Math.min(100, Number(score) || 0));
  return { circumference, dashArray: `${circumference} ${circumference}`, dashOffset: circumference * (1 - bounded / 100), radius, strokeWidth };
}

export function riskPartPercent(part) { return Math.round(part.value * part.weight * 100); }
