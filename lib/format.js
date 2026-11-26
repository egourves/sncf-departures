/**
 * Format a delay as "+12'" (with minuteSuffix "'") below an hour, "+2h30" or "+2h" from an hour.
 */
export function formatDelay(minutes, minuteSuffix) {
    if (minutes < 60)
        return `+${minutes}${minuteSuffix}`;
    const rest = minutes % 60;
    return `+${Math.floor(minutes / 60)}h${rest ? String(rest).padStart(2, '0') : ''}`;
}
